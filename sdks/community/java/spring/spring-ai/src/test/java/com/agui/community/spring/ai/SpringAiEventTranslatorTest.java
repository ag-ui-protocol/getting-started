package com.agui.community.spring.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.event.Event;
import com.agui.community.core.event.EventType;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;

/**
 * Verifies the chunk-to-event mapping deterministically by feeding
 * {@link ChatResponse} chunks straight to the translator (no {@code ChatClient}
 * or scheduling involved).
 */
class SpringAiEventTranslatorTest {

    @Test
    void mapsStreamedTextToTextMessageLifecycle() {
        List<Event> events = translate(chunk("Hello "), chunk("world"));

        assertEquals(
                List.of(
                        EventType.TEXT_MESSAGE_START,
                        EventType.TEXT_MESSAGE_CONTENT,
                        EventType.TEXT_MESSAGE_CONTENT,
                        EventType.TEXT_MESSAGE_END),
                types(events));

        TextMessageContentEvent first = assertInstanceOf(TextMessageContentEvent.class, events.get(1));
        assertEquals("msg-1", first.messageId());
        assertEquals("Hello ", first.delta());
    }

    @Test
    void dropsEmptyChunks() {
        long contentEvents = translate(chunk(""), chunk("only")).stream()
                .filter(e -> e.type() == EventType.TEXT_MESSAGE_CONTENT)
                .count();

        assertEquals(1, contentEvents);
    }

    @Test
    void mapsSingleChunkToolCallToToolCallLifecycle() {
        List<Event> events = translate(toolChunk("call-1", "get_weather", "{\"city\":\"Paris\"}"));

        assertEquals(
                List.of(
                        EventType.TOOL_CALL_START,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_END),
                types(events));

        ToolCallStartEvent start = assertInstanceOf(ToolCallStartEvent.class, events.get(0));
        assertEquals("call-1", start.toolCallId());
        assertEquals("get_weather", start.toolCallName());
        assertEquals("msg-1", start.parentMessageId());

        ToolCallArgsEvent args = assertInstanceOf(ToolCallArgsEvent.class, events.get(1));
        assertEquals("call-1", args.toolCallId());
        assertEquals("{\"city\":\"Paris\"}", args.delta());
    }

    @Test
    void emitsToolCallWhenProviderOmitsTheId() {
        // Ollama tool calls carry a name + arguments but no id; the whole call
        // arrives in a single chunk. The id must be synthesized, not dropped.
        List<Event> events = translate(toolChunk("", "get_weather", "{\"city\":\"Paris\"}"));

        assertEquals(
                List.of(
                        EventType.TOOL_CALL_START,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_END),
                types(events));

        ToolCallStartEvent start = assertInstanceOf(ToolCallStartEvent.class, events.get(0));
        assertEquals("get_weather", start.toolCallName());
        assertEquals("msg-1", start.parentMessageId());
        assertTrue(Objects.nonNull(start.toolCallId()) && !start.toolCallId().isEmpty(), "synthesized id");

        ToolCallArgsEvent args = assertInstanceOf(ToolCallArgsEvent.class, events.get(1));
        assertEquals(start.toolCallId(), args.toolCallId());
        assertEquals("{\"city\":\"Paris\"}", args.delta());
    }

    @Test
    void correlatesStreamedToolCallArgumentChunksById() {
        List<Event> events = translate(
                toolChunk("call-1", "search", "{\"q\":"),
                toolChunk("", "", "\"reactor\"}"));

        assertEquals(
                List.of(
                        EventType.TOOL_CALL_START,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_END),
                types(events));

        // The continuation chunk (no id) is attributed to the open tool call.
        ToolCallArgsEvent continuation = assertInstanceOf(ToolCallArgsEvent.class, events.get(2));
        assertEquals("call-1", continuation.toolCallId());
        assertEquals("\"reactor\"}", continuation.delta());
    }

    @Test
    void closesTextMessageBeforeStartingToolCall() {
        List<Event> events = translate(chunk("Let me check"), toolChunk("call-1", "lookup", "{}"));

        assertEquals(
                List.of(
                        EventType.TEXT_MESSAGE_START,
                        EventType.TEXT_MESSAGE_CONTENT,
                        EventType.TEXT_MESSAGE_END,
                        EventType.TOOL_CALL_START,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_END),
                types(events));
    }

    @Test
    void mapsThinkTagsToReasoningThenText() {
        List<Event> events = translate(chunk("<think>planning</think>answer"));

        assertEquals(
                List.of(
                        EventType.REASONING_START,
                        EventType.REASONING_MESSAGE_START,
                        EventType.REASONING_MESSAGE_CONTENT,
                        EventType.REASONING_MESSAGE_END,
                        EventType.REASONING_END,
                        EventType.TEXT_MESSAGE_START,
                        EventType.TEXT_MESSAGE_CONTENT,
                        EventType.TEXT_MESSAGE_END),
                types(events));

        ReasoningMessageContentEvent reasoning =
                assertInstanceOf(ReasoningMessageContentEvent.class, events.get(2));
        assertEquals("planning", reasoning.delta());
        TextMessageContentEvent text = assertInstanceOf(TextMessageContentEvent.class, events.get(6));
        assertEquals("answer", text.delta());
    }

    @Test
    void handlesThinkTagsSplitAcrossChunks() {
        List<Event> events =
                translate(chunk("<thi"), chunk("nk>reason"), chunk("ing</thi"), chunk("nk>done"));

        assertEquals(
                List.of(
                        EventType.REASONING_START,
                        EventType.REASONING_MESSAGE_START,
                        EventType.REASONING_MESSAGE_CONTENT,
                        EventType.REASONING_MESSAGE_CONTENT,
                        EventType.REASONING_MESSAGE_END,
                        EventType.REASONING_END,
                        EventType.TEXT_MESSAGE_START,
                        EventType.TEXT_MESSAGE_CONTENT,
                        EventType.TEXT_MESSAGE_END),
                types(events));

        String reasoning = events.stream()
                .filter(e -> e instanceof ReasoningMessageContentEvent)
                .map(e -> ((ReasoningMessageContentEvent) e).delta())
                .reduce("", String::concat);
        assertEquals("reasoning", reasoning);
    }

    @Test
    void interceptsStateToolCallAsStateSnapshot() {
        List<Event> events = translateWithStateTool(
                toolChunk("call-1", "update_state", "{\"state\":{\"count\":5}}"));

        assertEquals(List.of(EventType.STATE_SNAPSHOT), types(events));
        StateSnapshotEvent snapshot = assertInstanceOf(StateSnapshotEvent.class, events.get(0));
        Map<?, ?> state = assertInstanceOf(Map.class, snapshot.snapshot());
        assertEquals("5", String.valueOf(state.get("count")));
    }

    @Test
    void ignoresMalformedStateToolArgumentsInsteadOfEmittingGarbage() {
        // A small model can emit a truncated/partial tool call (e.g. just "{").
        List<Event> events = translateWithStateTool(toolChunk("", "update_state", "{"));

        assertEquals(List.of(), types(events));
    }

    @Test
    void parsesDoubleEncodedStateToolArguments() {
        // The model wrapped the state as a JSON string rather than an object.
        String args = """
                {"state": "{\\"count\\": 5}"}""";
        List<Event> events = translateWithStateTool(toolChunk("", "update_state", args));

        assertEquals(List.of(EventType.STATE_SNAPSHOT), types(events));
        StateSnapshotEvent snapshot = assertInstanceOf(StateSnapshotEvent.class, events.get(0));
        Map<?, ?> state = assertInstanceOf(Map.class, snapshot.snapshot());
        assertEquals("5", String.valueOf(state.get("count")));
    }

    @Test
    void surfacesOtherToolsWhileInterceptingTheStateTool() {
        List<Event> events = translateWithStateTool(
                toolChunk("call-1", "get_weather", "{\"city\":\"Paris\"}"),
                toolChunk("call-2", "update_state", "{\"state\":{\"x\":1}}"));

        assertEquals(
                List.of(
                        EventType.TOOL_CALL_START,
                        EventType.TOOL_CALL_ARGS,
                        EventType.TOOL_CALL_END,
                        EventType.STATE_SNAPSHOT),
                types(events));
    }

    @Test
    void skipsStateSnapshotWhenArgumentsAreUnparseable() {
        List<Event> events = translateWithStateTool(
                toolChunk("call-1", "update_state", "{\"state\": {incomplete"));

        assertEquals(List.of(), types(events));
    }

    private static List<Event> translate(ChatResponse... chunks) {
        return translate(new SpringAiEventTranslator("msg-1"), chunks);
    }

    private static List<Event> translateWithStateTool(ChatResponse... chunks) {
        return translate(new SpringAiEventTranslator("msg-1", "update_state"), chunks);
    }

    private static List<Event> translate(SpringAiEventTranslator translator, ChatResponse... chunks) {
        List<Event> events = new ArrayList<>();
        for (ChatResponse chunk : chunks) {
            events.addAll(translator.onChunk(chunk));
        }
        events.addAll(translator.finish());
        return events;
    }

    private static List<EventType> types(List<Event> events) {
        return events.stream().map(Event::type).toList();
    }

    private static ChatResponse chunk(String text) {
        return new ChatResponse(List.of(new Generation(new AssistantMessage(text))));
    }

    private static ChatResponse toolChunk(String id, String name, String arguments) {
        AssistantMessage message = AssistantMessage.builder()
                .toolCalls(List.of(new AssistantMessage.ToolCall(id, "function", name, arguments)))
                .build();
        return new ChatResponse(List.of(new Generation(message)));
    }
}
