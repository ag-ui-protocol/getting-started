package com.agui.adk.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

class UnseenMessageFilterTest {

    @Test
    void filtersProcessedMessageIdsAndToolCallIdsPreservingOrder() {
        UserMessage u1 = new UserMessage("m1", "hi", null);
        UserMessage u2 = new UserMessage("m2", "again", null);
        ToolMessage t = new ToolMessage("m3", "result", "tc-9", null);
        List<Message> msgs = List.of(u1, u2, t);
        // m1 and tc-9 processed -> only m2 remains.
        Set<String> processed = new LinkedHashSet<>(List.of("m1", "tc-9"));
        List<Message> unseen = UnseenMessageFilter.filter(msgs, processed);
        assertThat(unseen).hasSize(1);
        assertThat(unseen.get(0)).isSameAs(u2);
    }

    @Test
    void keepsEverythingWhenNothingProcessedAndEmptyInput() {
        UserMessage u1 = new UserMessage("m1", "hi", null);
        assertThat(UnseenMessageFilter.filter(List.of(u1), Set.of())).extracting(Message::id)
                .containsExactly("m1");
        assertThat(UnseenMessageFilter.filter(List.of(), Set.of("x"))).isEmpty();
        ToolMessage t = new ToolMessage("m2", "r", "tc-1", null);
        // empty processed -> tool message stays
        assertThat(UnseenMessageFilter.filter(List.of(t), Set.of("m2"))).isEmpty(); // m2 processed
        assertThat(UnseenMessageFilter.filter(List.of(t), Set.of())).hasSize(1);
    }

    @Test
    void filtersToolMessageWhenItsCallIdProcessedEvenIfIdNot() {
        ToolMessage t = new ToolMessage("m9", "r", "tc-5", null);
        // message id m9 NOT processed but tool_call_id tc-5 IS -> filtered (replay fix)
        assertThat(UnseenMessageFilter.filter(List.of(t), Set.of("tc-5"))).isEmpty();
    }

    @Test
    void collectsMessageIdsPreservingOrderAndEmptyInput() {
        Message u1 = new com.agui.community.core.message.UserMessage("m1", "hello");
        Message u2 = new com.agui.community.core.message.UserMessage("m2", "world");
        assertThat(UnseenMessageFilter.collectMessageIds(List.of(u1, u2))).containsExactly("m1", "m2");
        assertThat(UnseenMessageFilter.collectMessageIds(List.of(u1))).containsExactly("m1");
        assertThat(UnseenMessageFilter.collectMessageIds(List.of())).isEmpty();
        assertThat(UnseenMessageFilter.collectMessageIds(null)).isEmpty();
    }

    @Test
    void isToolResultSubmissionUsesLastUnseenMessage() {
        var user = new com.agui.community.core.message.UserMessage("u1", "hello");
        var tool = new com.agui.community.core.message.ToolMessage("t1", "r", "tc-1", null);
        assertThat(UnseenMessageFilter.isToolResultSubmission(List.of())).isFalse();
        assertThat(UnseenMessageFilter.isToolResultSubmission(List.of(user))).isFalse();
        assertThat(UnseenMessageFilter.isToolResultSubmission(List.of(tool))).isTrue();
        // last message governs
        assertThat(UnseenMessageFilter.isToolResultSubmission(List.of(tool, user))).isFalse();
        assertThat(UnseenMessageFilter.isToolResultSubmission(List.of(user, tool))).isTrue();
    }
}