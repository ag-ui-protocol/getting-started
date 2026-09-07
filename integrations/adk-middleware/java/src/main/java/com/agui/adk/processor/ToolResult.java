package com.agui.adk.processor;

import com.agui.community.core.message.ToolMessage;

/**
 * Imported validated tool result submitted back to Google ADK.
 *
 * @param toolName resolved tool name
 * @param message official AG-UI tool message
 */
public record ToolResult(String toolName, ToolMessage message) {
}
