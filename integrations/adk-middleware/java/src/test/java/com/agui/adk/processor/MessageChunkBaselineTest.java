package com.agui.adk.processor;

import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MessageChunkBaselineTest {

    @Test
    void emptyToolMessagesAreNotAToolSubmission() {
        MessageChunk chunk = new MessageChunk(List.of(), List.of(userMessage("user_msg")));

        assertThat(chunk.isToolSubmission()).isFalse();
    }

    @Test
    void nonEmptyToolMessagesAreAToolSubmission() {
        MessageChunk chunk = new MessageChunk(List.of(toolPlaceholder("tool_msg")), List.of());

        assertThat(chunk.isToolSubmission()).isTrue();
    }

    @Test
    void userSystemFactoryPreservesMessagesAndLeavesToolMessagesEmpty() {
        List<Message> userMessages = List.of(userMessage("user_msg_1"), userMessage("user_msg_2"));

        MessageChunk chunk = MessageChunk.fromUserSystemChunk(userMessages);

        assertThat(chunk.toolMessages()).isEmpty();
        assertThat(chunk.userSystemMessages()).isEqualTo(userMessages);
        assertThat(chunk.isToolSubmission()).isFalse();
    }

    @Test
    void constructorPreservesBothMessageGroups() {
        List<Message> toolMessages = List.of(toolPlaceholder("tool_msg_1"));
        List<Message> userMessages = List.of(userMessage("user_msg_1"));

        MessageChunk chunk = new MessageChunk(toolMessages, userMessages);

        assertThat(chunk.toolMessages()).isEqualTo(toolMessages);
        assertThat(chunk.userSystemMessages()).isEqualTo(userMessages);
        assertThat(chunk.isToolSubmission()).isTrue();
    }

    private static Message userMessage(String content) {
        return new UserMessage("user-1", content);
    }

    private static Message toolPlaceholder(String content) {
        return new UserMessage("tool-placeholder-1", content);
    }
}
