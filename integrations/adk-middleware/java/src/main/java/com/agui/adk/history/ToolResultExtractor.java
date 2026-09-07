package com.agui.adk.history;

import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure port of the Python {@code ADKAgent._extract_tool_results}: extracts tool-role messages with
 * their resolved function names, skipping the synthetic {@code confirm_changes} results that the
 * middleware emits to trigger the frontend confirmation dialog but that ADK never actually called.
 */
public final class ToolResultExtractor {

    /** Synthetic tool call name emitted by the middleware to raise the confirmation UI. */
    public static final String CONFIRM_CHANGES = "confirm_changes";

    /** The fallback name when a tool result's call id has no preceding assistant tool call. */
    public static final String UNKNOWN_NAME = "unknown";

    private ToolResultExtractor() {
    }

    /** An extracted tool result: the resolved function name and the tool message. */
    public record ToolResult(String toolName, ToolMessage message) {
    }

    /**
     * Extracts tool messages with their names from a message list, chronologically ordered,
     * skipping synthetic {@code confirm_changes} results (Python {@code _extract_tool_results}).
     *
     * @param messages the AG-UI messages (assistant calls may precede tool results in the batch)
     * @return extracted tool-name/message pairs
     */
    public static List<ToolResult> extractToolResults(List<Message> messages) {
        Map<String, String> toolCallMap = new HashMap<>();
        for (Message message : messages) {
            if (message instanceof AssistantMessage assistant && assistant.toolCalls() != null) {
                for (ToolCall toolCall : assistant.toolCalls()) {
                    toolCallMap.put(toolCall.id(), toolCall.function().name());
                }
            }
        }
        List<ToolResult> extracted = new ArrayList<>();
        for (Message message : messages) {
            if (message instanceof ToolMessage toolMessage) {
                String toolName = toolCallMap.getOrDefault(toolMessage.toolCallId(), UNKNOWN_NAME);
                if (CONFIRM_CHANGES.equals(toolName)) {
                    continue;
                }
                extracted.add(new ToolResult(toolName, toolMessage));
            }
        }
        return extracted;
    }
}
