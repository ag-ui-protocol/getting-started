package com.agui.adk.endpoint;

import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pure port of the Python {@code endpoint.py resolve_agent_from_message_history}: resolves a
 * tool-result resumption to its originating agent. Routes on the latest ToolMessage's
 * {@code tool_call_id}, matching it to prior {@code AssistantMessage.tool_calls[].id} in the same
 * history, and returns the registry agent keyed by the assistant's {@code name}. Returns
 * {@code null} when the latest message is not a tool result, no matching assistant message exists,
 * the assistant has no registry key in {@code name}, or the key is unknown - so the caller can
 * safely fall back to its normal routing policy.
 *
 * @param <T> the agent registry value type
 */
public final class AgentResolver<T> {

    private AgentResolver() {
    }

    /**
     * Resolves the agent for a tool-result resumption from the message history.
     *
     * @param <T>            the agent registry value type
     * @param messages       the message history (last message may be a tool result)
     * @param agentRegistry  name -&gt; agent registry
     * @return the registry agent, or null
     */
    public static <T> T resolveAgentFromMessageHistory(List<Message> messages, Map<String, T> agentRegistry) {
        if (messages == null || messages.isEmpty() || !(messages.get(messages.size() - 1) instanceof ToolMessage)) {
            return null;
        }
        ToolMessage toolMessage = (ToolMessage) messages.get(messages.size() - 1);
        for (int i = messages.size() - 2; i >= 0; i--) {
            Message message = messages.get(i);
            if (!(message instanceof AssistantMessage assistant)) {
                continue;
            }
            Set<String> toolCallIds = new HashSet<>();
            if (assistant.toolCalls() != null) {
                for (ToolCall toolCall : assistant.toolCalls()) {
                    toolCallIds.add(toolCall.id());
                }
            }
            if (!toolCallIds.contains(toolMessage.toolCallId())) {
                continue;
            }
            if (assistant.name() == null) {
                return null;
            }
            return agentRegistry.get(assistant.name());
        }
        return null;
    }
}
