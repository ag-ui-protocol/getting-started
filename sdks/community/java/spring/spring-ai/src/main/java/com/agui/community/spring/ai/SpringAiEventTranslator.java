package com.agui.community.spring.ai;

import com.agui.community.core.event.Event;
import com.agui.community.core.event.ReasoningEndEvent;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.ReasoningMessageEndEvent;
import com.agui.community.core.event.ReasoningMessageStartEvent;
import com.agui.community.core.event.ReasoningStartEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.message.Role;

import java.util.*;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.util.JsonHelper;

/**
 * Translates a stream of Spring AI {@link ChatResponse} chunks into the AG-UI
 * event lifecycle for a single run. It is <strong>stateful</strong> and not
 * thread-safe: one instance handles one run, and its methods are invoked
 * sequentially as chunks arrive.
 *
 * <p>Three kinds of output are mapped:
 *
 * <pre>
 * TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT*, TEXT_MESSAGE_END
 * REASONING_START, REASONING_MESSAGE_START, REASONING_MESSAGE_CONTENT*, REASONING_MESSAGE_END, REASONING_END
 * TOOL_CALL_START, TOOL_CALL_ARGS*, TOOL_CALL_END
 * </pre>
 *
 * <p>Reasoning is detected from inline {@code <think>...</think>} tags in the
 * streamed text via {@link ReasoningSegmenter}; content inside the tags becomes
 * the reasoning sub-stream and content outside becomes text. Switching between
 * text, reasoning and tool calls closes whichever message is currently open
 * before opening the next, and anything still open is closed by {@link #finish()}
 * when the stream completes.
 *
 * <p>If a state tool name is supplied, a call to that tool is intercepted: rather
 * than surfacing {@code TOOL_CALL_*} events, its streamed arguments are buffered
 * and reinterpreted as the complete new shared state, emitted as a
 * {@code STATE_SNAPSHOT} when the stream completes.
 */
final class SpringAiEventTranslator {

    private static final Logger log = LoggerFactory.getLogger(SpringAiEventTranslator.class);

    /** Jackson-backed JSON parser for tool-call and state payloads. */
    private static final JsonHelper JSON = new JsonHelper();

    private enum Mode {
        NONE,
        TEXT,
        REASONING
    }

    private final String messageId;
    private final String stateToolName;
    private final ReasoningSegmenter segmenter = new ReasoningSegmenter();

    private Mode mode = Mode.NONE;
    private boolean textOpen;
    private boolean reasoningPhaseOpen;
    private boolean reasoningMessageOpen;

    private final Set<String> startedToolCalls = new LinkedHashSet<>();
    private final Set<String> openToolCalls = new LinkedHashSet<>();
    // Accumulated name + arguments per surfaced (non-state) tool call, in order, so
    // the agent can execute backend tools and re-prompt after the turn.
    private final Map<String, ToolCallBuffer> toolCallBuffers = new LinkedHashMap<>();
    private String currentToolCallId;
    private int syntheticToolCallCount;

    private static final class ToolCallBuffer {
        private final String name;
        private final StringBuilder arguments = new StringBuilder();

        ToolCallBuffer(String name) {
            this.name = name;
        }
    }

    // A call to the state tool is intercepted: its streamed arguments are buffered
    // (not surfaced as TOOL_CALL_* events) and reinterpreted as a STATE_SNAPSHOT.
    private String stateToolCallId;
    private final StringBuilder stateToolArguments = new StringBuilder();

    SpringAiEventTranslator(String messageId) {
        this(messageId, null);
    }

    SpringAiEventTranslator(String messageId, String stateToolName) {
        this.messageId = messageId;
        this.stateToolName = stateToolName;
    }

    /**
     * Maps a single streamed chunk to zero or more AG-UI events.
     *
     * @param response the chunk to translate
     * @return the events to emit, in order
     */
    List<Event> onChunk(ChatResponse response) {
        List<Event> events = new ArrayList<>();
        if (Objects.isNull(response) || Objects.isNull(response.getResult())) {
            return events;
        }
        AssistantMessage message = response.getResult().getOutput();

        String text = message.getText();
        if (Objects.nonNull(text) && !text.isEmpty()) {
            for (ReasoningSegmenter.Segment segment : segmenter.feed(text)) {
                emitSegment(segment, events);
            }
        }

        if (message.hasToolCalls()) {
            closeOpenMessage(events);
            for (AssistantMessage.ToolCall toolCall : message.getToolCalls()) {
                handleToolCall(toolCall, events);
            }
        }
        return events;
    }

    /**
     * Emits the closing events for any text, reasoning or tool calls still open
     * when the stream completes.
     *
     * @return the terminal events, in order
     */
    List<Event> finish() {
        List<Event> events = new ArrayList<>();
        for (ReasoningSegmenter.Segment segment : segmenter.flush()) {
            emitSegment(segment, events);
        }
        closeOpenMessage(events);
        for (String id : openToolCalls) {
            events.add(new ToolCallEndEvent(id));
        }
        openToolCalls.clear();
        if (Objects.nonNull(stateToolCallId)) {
            Object snapshot = parseStateSnapshot();
            if (Objects.nonNull(snapshot)) {
                events.add(new StateSnapshotEvent(snapshot));
            } else {
                log.debug("Ignoring state update; could not parse a state object from "
                        + "'{}' tool arguments: {}", stateToolName, stateToolArguments);
            }
        }
        return events;
    }

    private void emitSegment(ReasoningSegmenter.Segment segment, List<Event> events) {
        if (segment.text().isEmpty()) {
            return;
        }
        if (segment.kind() == ReasoningSegmenter.Kind.REASONING) {
            enterReasoning(events);
            events.add(new ReasoningMessageContentEvent(messageId, segment.text()));
        } else {
            enterText(events);
            events.add(new TextMessageContentEvent(messageId, segment.text()));
        }
    }

    private void enterText(List<Event> events) {
        if (mode == Mode.REASONING) {
            closeReasoning(events);
        }
        if (!textOpen) {
            events.add(new TextMessageStartEvent(messageId, Role.ASSISTANT));
            textOpen = true;
        }
        mode = Mode.TEXT;
    }

    private void enterReasoning(List<Event> events) {
        if (mode == Mode.TEXT) {
            closeText(events);
        }
        if (!reasoningPhaseOpen) {
            events.add(new ReasoningStartEvent(messageId));
            reasoningPhaseOpen = true;
        }
        if (!reasoningMessageOpen) {
            events.add(new ReasoningMessageStartEvent(messageId));
            reasoningMessageOpen = true;
        }
        mode = Mode.REASONING;
    }

    private void closeText(List<Event> events) {
        if (textOpen) {
            events.add(new TextMessageEndEvent(messageId));
            textOpen = false;
        }
        if (mode == Mode.TEXT) {
            mode = Mode.NONE;
        }
    }

    private void closeReasoning(List<Event> events) {
        if (reasoningMessageOpen) {
            events.add(new ReasoningMessageEndEvent(messageId));
            reasoningMessageOpen = false;
        }
        if (reasoningPhaseOpen) {
            events.add(new ReasoningEndEvent(messageId));
            reasoningPhaseOpen = false;
        }
        if (mode == Mode.REASONING) {
            mode = Mode.NONE;
        }
    }

    private void closeOpenMessage(List<Event> events) {
        if (mode == Mode.TEXT) {
            closeText(events);
        } else if (mode == Mode.REASONING) {
            closeReasoning(events);
        }
    }

    private void handleToolCall(AssistantMessage.ToolCall toolCall, List<Event> events) {
        String id = toolCall.id();
        String name = toolCall.name();
        String arguments = toolCall.arguments();

        if (isPresent(name)) {
            // Start of a tool call. Some providers (notably Ollama) omit the call
            // id; synthesize a stable one so the call is still tracked and emitted.
            String callId = isPresent(id) ? id : syntheticToolCallId();
            if (startedToolCalls.add(callId)) {
                if (isStateTool(name)) {
                    stateToolCallId = callId;
                } else {
                    events.add(new ToolCallStartEvent(callId, name, messageId, null, null));
                    openToolCalls.add(callId);
                    toolCallBuffers.put(callId, new ToolCallBuffer(name));
                }
            }
            currentToolCallId = callId;
            appendToolArguments(callId, arguments, events);
        } else {
            // No name: an argument-delta continuation (the streaming pattern used by
            // OpenAI-style providers, where only the first chunk carries id + name).
            String target = isPresent(id) ? id : currentToolCallId;
            if (Objects.nonNull(target)) {
                currentToolCallId = target;
                appendToolArguments(target, arguments, events);
            }
        }
    }

    private static boolean isPresent(String value) {
        return Objects.nonNull(value) && !value.isEmpty();
    }

    private String syntheticToolCallId() {
        return messageId + "-tool-" + (++syntheticToolCallCount);
    }

    private void appendToolArguments(String id, String arguments, List<Event> events) {
        if (Objects.isNull(arguments) || arguments.isEmpty()) {
            return;
        }
        if (id.equals(stateToolCallId)) {
            stateToolArguments.append(arguments);
        } else {
            ToolCallBuffer buffer = toolCallBuffers.get(id);
            if (Objects.nonNull(buffer)) {
                buffer.arguments.append(arguments);
            }
            events.add(new ToolCallArgsEvent(id, arguments));
        }
    }

    /** @return the message id used for this turn's assistant message. */
    String messageId() {
        return messageId;
    }

    /**
     * @return the non-state tool calls surfaced this turn (id, name, full
     *         arguments), in order — for the agent to execute backend tools and
     *         re-prompt.
     */
    List<AssistantMessage.ToolCall> collectedToolCalls() {
        List<AssistantMessage.ToolCall> calls = new ArrayList<>();
        for (Map.Entry<String, ToolCallBuffer> entry : toolCallBuffers.entrySet()) {
            ToolCallBuffer buffer = entry.getValue();
            calls.add(new AssistantMessage.ToolCall(
                    entry.getKey(), "function", buffer.name, buffer.arguments.toString()));
        }
        return calls;
    }

    private boolean isStateTool(String name) {
        return Objects.nonNull(stateToolName) && stateToolName.equals(name);
    }

    /**
     * Reinterprets the buffered state-tool arguments as the new shared state. The
     * arguments are a JSON object with a single {@code state} property holding the
     * complete new state.
     *
     * @return the snapshot, or {@code null} if absent or unparseable
     */
    private Object parseStateSnapshot() {
        if (stateToolArguments.length() == 0) {
            return null;
        }
        Object parsed = tryParseJson(stateToolArguments.toString());
        // Unwrap the {"state": ...} envelope declared by the tool schema.
        if (parsed instanceof Map<?, ?> object && object.containsKey("state")) {
            parsed = object.get("state");
        }
        // A model may double-encode the state as a JSON string; parse it again.
        if (parsed instanceof String string) {
            parsed = tryParseJson(string);
        }
        // Only accept a structured state value; ignore scalars/partial JSON (e.g. a
        // truncated "{" from a malformed tool call) rather than emitting garbage.
        if (parsed instanceof Map || parsed instanceof List) {
            return parsed;
        }
        return null;
    }

    private static Object tryParseJson(String json) {
        try {
            return JSON.fromJson(json, Object.class);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
