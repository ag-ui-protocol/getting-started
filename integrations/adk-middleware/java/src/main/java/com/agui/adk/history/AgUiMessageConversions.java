package com.agui.adk.history;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.SystemMessage;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Pure ports of the Python {@code utils/converters.py} message conversions.
 */
public final class AgUiMessageConversions {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private AgUiMessageConversions() {
    }

    /**
     * Converts an ADK event to an AG-UI message (Python
     * {@code convert_adk_event_to_ag_ui_message}): skips events without content parts; a
     * {@code user}-authored event becomes a {@code UserMessage} of its joined part text; any other
     * author becomes an {@code AssistantMessage} of its joined text plus tool calls (a name
     * different from {@code model} is kept, else null). Returns empty when not convertible.
     *
     * @param event ADK session event
     * @return the AG-UI message, or empty
     */
    public static Optional<Message> convertAdkEventToAgUiMessage(Event event) {
        Content content = event.content().orElse(null);
        if (content == null || content.parts().isEmpty()) {
            return Optional.empty();
        }
        List<Part> parts = content.parts().orElse(List.of());
        String author = event.author();
        String eventId = event.id();
        if ("user".equals(author)) {
            List<String> text = textParts(parts);
            if (text.isEmpty()) {
                return Optional.empty();
            }
            return Optional.of(new UserMessage(eventId, String.join("\n", text)));
        }
        List<String> text = textParts(parts);
        List<ToolCall> toolCalls = new ArrayList<>();
        for (Part part : parts) {
            if (part.text().isPresent()) {
                continue;
            }
            if (part.functionCall().isPresent()) {
                FunctionCall fc = part.functionCall().orElseThrow();
                String id = fc.id().orElse(eventId);
                Map<String, Object> args = fc.args().isPresent() ? fc.args().orElseThrow() : null;
                toolCalls.add(new ToolCall(id, new com.agui.community.core.message.FunctionCall(
                        fc.name().orElse(""), args == null ? "{}" : toJson(args))));
            }
        }
        String assistantName = (author != null && !"model".equals(author)) ? author : null;
        String textContent = text.isEmpty() ? null : String.join("\n", text);
        return Optional.of(new AssistantMessage(eventId, textContent, assistantName,
                toolCalls.isEmpty() ? null : toolCalls));
    }

    /**
     * Converts AG-UI messages back to ADK events (Python {@code convert_ag_ui_messages_to_adk}):
     * user/system become text content, assistants become {@code model}-role content carrying text
     * and function calls, tool messages become function responses whose {@code name} is resolved
     * from a prior assistant tool call by id (falling back to the tool_call_id).
     *
     * @param messages AG-UI messages
     * @return ADK events
     */
    public static List<Event> convertAgUiMessagesToAdk(List<Message> messages) {
        Map<String, String> toolCallIdToName = new HashMap<>();
        for (Message message : messages) {
            if (message instanceof AssistantMessage assistant && assistant.toolCalls() != null) {
                for (ToolCall toolCall : assistant.toolCalls()) {
                    toolCallIdToName.put(toolCall.id(), toolCall.function().name());
                }
            }
        }
        List<Event> events = new ArrayList<>();
        for (Message message : messages) {
            try {
                if (message instanceof UserMessage || message instanceof SystemMessage) {
                    List<Part> parts = contentToParts(message.content());
                    if (!parts.isEmpty()) {
                        events.add(Event.builder().id(message.id()).author(roleLower(message.role()))
                                .content(Content.builder().role(roleLower(message.role())).parts(parts).build()).build());
                    }
                } else if (message instanceof AssistantMessage assistant) {
                    String author = assistant.name() != null ? assistant.name() : "model";
                    List<Part> parts = new ArrayList<>();
                    if (assistant.content() != null) {
                        parts.addAll(contentToParts(assistant.content()));
                    }
                    if (assistant.toolCalls() != null) {
                        for (ToolCall toolCall : assistant.toolCalls()) {
                            Map<String, Object> args = parseArgs(toolCall.function().arguments());
                            parts.add(Part.builder().functionCall(FunctionCall.builder()
                                    .name(toolCall.function().name()).args(args).id(toolCall.id()).build()).build());
                        }
                    }
                    if (!parts.isEmpty()) {
                        events.add(Event.builder().id(message.id()).author(author)
                                .content(Content.builder().role("model").parts(parts).build()).build());
                    }
                } else if (message instanceof ToolMessage toolMessage) {
                    String functionName = toolCallIdToName.getOrDefault(toolMessage.toolCallId(), toolMessage.toolCallId());
                    Map<String, Object> response = toolMessage.content() == null
                            ? null : Map.of("result", toolMessage.content());
                    events.add(Event.builder().id(message.id()).author(roleLower(message.role()))
                            .content(Content.builder().role("function").parts(List.of(
                                    Part.builder().functionResponse(FunctionResponse.builder()
                                            .name(functionName).response(response).id(toolMessage.toolCallId()).build())
                                            .build())).build()).build());
                }
            } catch (Exception ignored) {
                // Python logs and continues on a per-message conversion failure.
            }
        }
        return events;
    }

    /**
     * Extracts the non-empty text of the given parts, preserving order (Python text-truthy check).
     *
     * @param parts the content parts
     * @return the non-empty text values
     */
    private static List<String> textParts(List<Part> parts) {
        List<String> text = new ArrayList<>();
        for (Part part : parts) {
            part.text().filter(t -> !t.isEmpty()).ifPresent(text::add);
        }
        return text;
    }

    /**
     * Converts a plain-string message content into a single text part.
     *
     * @param content the content string
     * @return a one-element text-part list, or empty for null/blank content
     */
    private static List<Part> contentToParts(String content) {
        if (content == null || content.isEmpty()) {
            return List.of();
        }
        return List.of(Part.builder().text(content).build());
    }

    /**
     * Parses a function-call arguments string into a map (Python {@code json.loads}).
     *
     * @param arguments the arguments JSON string
     * @return the parsed map, or an empty map when null/blank/not-an-object/parse-failure
     */
    private static Map<String, Object> parseArgs(String arguments) {
        if (arguments == null || arguments.isEmpty()) {
            return Map.of();
        }
        try {
            Object parsed = MAPPER.readValue(arguments, Object.class);
            return parsed instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
        } catch (Exception e) {
            return Map.of();
        }
    }

    private static String roleLower(com.agui.community.core.message.Role role) {
        return role.name().toLowerCase();
    }

    /**
     * Serializes an arguments map to compact JSON.
     *
     * @param args the arguments map
     * @return the compact JSON string, or {@code "{}"} on serialization failure
     */
    private static String toJson(Map<String, Object> args) {
        try {
            return MAPPER.writeValueAsString(args);
        } catch (Exception e) {
            return "{}";
        }
    }
}
