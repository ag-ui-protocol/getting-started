package com.agui.adk.processor;

import com.agui.community.core.message.Message;

import java.util.List;

/**
 * Imported grouping of consecutive tool and non-tool messages.
 *
 * @param toolMessages leading tool messages
 * @param userSystemMessages following user or system messages
 */
public record MessageChunk(List<Message> toolMessages, List<Message> userSystemMessages) {
    public boolean isToolSubmission() {
        return !toolMessages.isEmpty();
    }

    public static MessageChunk fromUserSystemChunk(List<Message> userSystemChunk) {
        return new MessageChunk(List.of(), userSystemChunk);
    }
}
