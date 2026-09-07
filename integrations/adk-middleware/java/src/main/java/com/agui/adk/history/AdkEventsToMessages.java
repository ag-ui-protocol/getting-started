package com.agui.adk.history;

import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FileData;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.agui.adk.serialization.ToolResponseSerializer;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.DeveloperMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Pure port of the Python {@code adk_events_to_messages}: projects ADK session events into an
 * AG-UI {@code Message} history, skipping partial/empty events, separating thought parts,
 * turning function responses into {@code ToolMessage}s and non-user turns into
 * {@code AssistantMessage}s carrying their {@code ToolCall}s.
 *
 * <p>The agui4j core 0.2.0 model lacks the protocol's reasoning-message type and restricts user
 * content to a string. Reasoning is therefore preserved, in order, as a developer message named
 * {@code reasoning}; user multimodal content is preserved as compact JSON for the canonical AG-UI
 * input-content array. These are lossless closest-equivalent fallbacks until the Java protocol model
 * exposes the native reasoning role and typed user-content union.
 */
public final class AdkEventsToMessages {

    private AdkEventsToMessages() {
    }

    /**
     * Converts ADK session events into an AG-UI message history.
     *
     * @param events ADK session events (session.events)
     * @return ordered AG-UI messages representing the representable conversation history
     */
    public static List<Message> convert(List<Event> events) {
        List<Message> messages = new ArrayList<>();
        for (Event event : events) {
            if (event.content().isEmpty()) {
                continue;
            }
            if (event.partial().orElse(false)) {
                continue;
            }
            Content content = event.content().orElseThrow();
            List<Part> parts = content.parts().orElse(List.of());
            if (parts.isEmpty()) {
                continue;
            }

            EventParts eventParts = collectParts(parts);
            if (!eventParts.functionResponses().isEmpty()) {
                addToolMessages(messages, eventParts.functionResponses());
                continue;
            }
            if (eventParts.isEmpty()) {
                continue;
            }

            String eventId = event.id() != null ? event.id() : UUID.randomUUID().toString();
            if ("user".equals(event.author())) {
                addUserMessage(messages, eventId, eventParts);
            } else {
                addAssistantMessages(messages, eventId, event.author(), eventParts);
            }
        }
        return messages;
    }

    /**
     * Classifies an event's parts into text, reasoning, calls, responses, and files.
     *
     * @param parts ADK event parts
     * @return classified event content
     */
    private static EventParts collectParts(List<Part> parts) {
        StringBuilder text = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        List<FunctionCall> functionCalls = new ArrayList<>();
        List<FunctionResponse> functionResponses = new ArrayList<>();
        List<FileData> files = new ArrayList<>();
        for (Part part : parts) {
            part.text().ifPresent(value -> {
                if (Boolean.TRUE.equals(part.thought().orElse(false))) {
                    reasoning.append(value);
                } else {
                    text.append(value);
                }
            });
            part.functionCall().ifPresent(functionCalls::add);
            part.functionResponse().ifPresent(functionResponses::add);
            part.fileData().filter(file -> file.fileUri().filter(uri -> !uri.isBlank()).isPresent())
                    .ifPresent(files::add);
        }
        return new EventParts(text.toString(), reasoning.toString(), functionCalls, functionResponses, files);
    }

    /**
     * Appends tool messages for all function responses in one ADK event.
     *
     * @param messages target message list
     * @param responses function responses to translate
     */
    private static void addToolMessages(List<Message> messages, List<FunctionResponse> responses) {
        for (FunctionResponse response : responses) {
            String toolCallId = response.id().orElse(UUID.randomUUID().toString());
            String content = response.response().map(ToolResponseSerializer::serialize).orElse("");
            messages.add(new ToolMessage(UUID.randomUUID().toString(), content, toolCallId, null));
        }
    }

    /**
     * Appends a representable user message, preserving file references as typed JSON content.
     *
     * @param messages target message list
     * @param eventId source event identifier
     * @param parts classified event content
     */
    private static void addUserMessage(List<Message> messages, String eventId, EventParts parts) {
        if (parts.text().isEmpty()) {
            return;
        }
        String content = parts.files().isEmpty()
                ? parts.text() : serializeMultimodalUserContent(parts.text(), parts.files());
        messages.add(new UserMessage(eventId, content));
    }

    /**
     * Appends reasoning and assistant messages for a non-user ADK event.
     *
     * @param messages target message list
     * @param eventId source event identifier
     * @param author source event author
     * @param parts classified event content
     */
    private static void addAssistantMessages(
            List<Message> messages, String eventId, String author, EventParts parts) {
        if (!parts.reasoning().isEmpty()) {
            messages.add(new DeveloperMessage(eventId + "-reasoning", parts.reasoning(), "reasoning"));
        }
        List<ToolCall> toolCalls = parts.functionCalls().isEmpty()
                ? null : translateFunctionCalls(parts.functionCalls());
        if (!parts.text().isEmpty() || toolCalls != null) {
            String name = author != null && !"model".equals(author) && !"user".equals(author) ? author : null;
            messages.add(new AssistantMessage(
                    eventId, parts.text().isEmpty() ? null : parts.text(), name, toolCalls));
        }
    }

    /**
     * Encodes the protocol's typed user-content array in the string slot available in agui4j 0.2.0.
     *
     * @param text visible user text
     * @param files ADK file references with non-empty URIs
     * @return compact lossless JSON for TextInputContent followed by typed media content
     */
    private static String serializeMultimodalUserContent(String text, List<FileData> files) {
        List<Map<String, Object>> content = new ArrayList<>();
        content.add(Map.of("type", "text", "text", text));
        for (FileData file : files) {
            String mimeType = file.mimeType().orElse("");
            String mediaType = mimeType.startsWith("image/") ? "image"
                    : mimeType.startsWith("audio/") ? "audio"
                    : mimeType.startsWith("video/") ? "video" : "document";
            Map<String, Object> source = new java.util.LinkedHashMap<>();
            source.put("type", "url");
            source.put("value", file.fileUri().orElseThrow());
            if (!mimeType.isBlank()) {
                source.put("mimeType", mimeType);
            }
            content.add(Map.of("type", mediaType, "source", source));
        }
        return ToolResponseSerializer.serialize(content);
    }

    /**
     * Converts ADK function calls to AG-UI {@code ToolCall}s (Python
     * {@code _translate_function_calls_to_tool_calls}); arguments serialize to compact JSON.
     *
     * @param calls function calls from one event
     * @return AG-UI tool calls
     */
    private static List<ToolCall> translateFunctionCalls(List<FunctionCall> calls) {
        List<ToolCall> out = new ArrayList<>();
        for (FunctionCall fc : calls) {
            String id = fc.id().orElse(UUID.randomUUID().toString());
            String args = fc.args().isPresent()
                    ? com.agui.adk.serialization.ToolCallSerialization
                            .serializeToolArgs(fc.args().orElseThrow())
                    : "{}";
            out.add(new ToolCall(id, new com.agui.community.core.message.FunctionCall(
                    fc.name().orElse(""), args)));
        }
        return out;
    }

    /** Classified content extracted from one complete ADK event. */
    private record EventParts(
            String text,
            String reasoning,
            List<FunctionCall> functionCalls,
            List<FunctionResponse> functionResponses,
            List<FileData> files) {

        private boolean isEmpty() {
            return text.isEmpty() && reasoning.isEmpty() && functionCalls.isEmpty();
        }
    }

    /**
     * Finds the invocation id of the event that authored a {@code FunctionCall} whose id equals
     * {@code toolCallId} (Python {@code _find_function_call_invocation_id}): reads session history
     * so any FunctionResponse pre-appended carries a consistent invocation id with the upstream
     * call. Returns {@code null} when no matching call event is found.
     *
     * @param events     ADK session events
     * @param toolCallId the tool-call id to match against a FunctionCall part's id
     * @return the owning event's invocation id, or {@code null}
     */
    public static String findFunctionCallInvocationId(List<Event> events, String toolCallId) {
        for (Event event : events) {
            List<Part> parts = event.content().flatMap(Content::parts).orElse(List.of());
            for (Part part : parts) {
                FunctionCall fc = part.functionCall().orElse(null);
                if (fc != null && fc.id().isPresent() && fc.id().orElseThrow().equals(toolCallId)) {
                    return event.invocationId();
                }
            }
        }
        return null;
    }
}
