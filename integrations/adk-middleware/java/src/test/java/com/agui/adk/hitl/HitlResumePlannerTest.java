package com.agui.adk.hitl;

import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class HitlResumePlannerTest {
    @Test
    void rejectsUnknownToolAlongsideCurrentFrontendResult() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        PendingToolCall current = call(group, "current");
        HitlResumePlanner planner = new HitlResumePlanner();

        HitlResumePlanner.Plan plan = planner.plan(List.of(current), Map.of(), Set.of(), List.of(
                new ToolMessage("result-current", "{}", "current"),
                new ToolMessage("result-unknown", "{}", "unknown")));

        assertThat(plan.errorCode()).isEqualTo("UNKNOWN_TOOL_RESULT");
    }

    @Test
    void acceptsTrailingUserAfterCompleteFrontendResultBatch() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingToolCall current = call(new PendingCallGroupKey(scope, "turn"), "current");
        HitlResumePlanner planner = new HitlResumePlanner();

        HitlResumePlanner.Plan plan = planner.plan(List.of(current), Map.of(), Set.of(), List.of(
                new ToolMessage("result-current", "{}", "current"),
                new UserMessage("user", "continue")));

        assertThat(plan.errorCode()).isNull();
        assertThat(plan.frontendResults()).hasSize(1);
        assertThat(plan.remainingMessages()).singleElement().isInstanceOf(UserMessage.class);
    }

    @Test
    void rejectsTrailingUserWhileSameGroupRemainsIncomplete() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        HitlResumePlanner.Plan plan = new HitlResumePlanner().plan(
                List.of(call(group, "first"), call(group, "second")), Map.of(), Set.of(), List.of(
                        new ToolMessage("result-first", "{}", "first"),
                        new UserMessage("user", "continue")));

        assertThat(plan.errorCode()).isEqualTo("PENDING_CALLS");
    }

    @Test
    void acceptsTrailingUserWhenBufferedSiblingCompletesSameGroup() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        HitlResumePlanner.Plan plan = new HitlResumePlanner().plan(
                List.of(call(group, "first"), call(group, "second")), Map.of(), Set.of("first"), List.of(
                        new ToolMessage("result-second", "{}", "second"),
                        new UserMessage("user", "continue")));

        assertThat(plan.errorCode()).isNull();
        assertThat(plan.remainingMessages()).singleElement().isInstanceOf(UserMessage.class);
    }

    @Test
    void rejectsFrontendResultsFromMoreThanOneCurrentGroup() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingToolCall first = call(new PendingCallGroupKey(scope, "turn-1"), "first");
        PendingToolCall second = call(new PendingCallGroupKey(scope, "turn-2"), "second");

        HitlResumePlanner.Plan plan = new HitlResumePlanner().plan(List.of(first, second), Map.of(), Set.of(), List.of(
                new ToolMessage("result-first", "{}", "first"),
                new ToolMessage("result-second", "{}", "second")));

        assertThat(plan.errorCode()).isEqualTo("PENDING_CALLS");
    }

    @Test
    void rejectsConsumedCallReplayWhenItsDurableMessageFingerprintDiffers() {
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingToolCall current = call(new PendingCallGroupKey(scope, "turn"), "current");
        ToolMessage consumed = new ToolMessage("result-old", "{\"value\":1}", "old");
        ToolMessage conflictingReplay = new ToolMessage("result-old", "{\"value\":2}", "old");

        HitlResumePlanner.Plan plan = new HitlResumePlanner().plan(List.of(current), Map.of(
                "old", ConsumedToolResult.from(consumed, new ToolResultNormalizer())), Set.of(), List.of(
                conflictingReplay,
                new ToolMessage("result-current", "{}", "current")));

        assertThat(plan.errorCode()).isEqualTo("UNKNOWN_TOOL_RESULT");
    }

    @Test
    void doesNotTreatHistoricalServerToolAsFrontendAndKeepsFollowingUser() {
        HitlResumePlanner.Plan plan = new HitlResumePlanner().plan(List.of(), Map.of(), Set.of(), List.of(
                new ToolMessage("server-result", "{}", "server-call"),
                new UserMessage("user", "continue")));

        assertThat(plan.errorCode()).isNull();
        assertThat(plan.frontendResults()).isEmpty();
        assertThat(plan.remainingMessages()).hasSize(2);
    }

    private static PendingToolCall call(PendingCallGroupKey group, String id) {
        return new PendingToolCall(new PendingCallKey(group, id),
                new com.agui.community.core.event.ToolCallChunkEvent(id, "tool", "parent", "{}", 1L, null),
                "{}", PendingStatus.PENDING);
    }
}
