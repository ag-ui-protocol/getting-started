package com.agui.adk.hitl;

import com.agui.community.core.event.ToolCallChunkEvent;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;

class MultiToolResumeGatingTest {
    @Test
    void buffersPartialAndOutOfOrderResultsThenReturnsExactlyOneReadyGroup() {
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        persist(store, group, "one", "first");
        persist(store, group, "two", "second");

        assertInstanceOf(BufferedToolResult.class, store.submitResult(group, result("two")).blockingGet());
        assertInstanceOf(ResumeClaim.class, store.submitResult(group, result("one")).blockingGet());
        assertInstanceOf(PendingResultTransition.Duplicate.class,
                store.submitResult(group, result("one")).blockingGet());
    }

    @Test
    void resubmissionReclaimsReleasedCompleteGroup() {
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        persist(store, group, "call", "tool");

        ResumeClaim first = (ResumeClaim) store.submitResult(group, result("call")).blockingGet();
        store.release(first).blockingAwait();

        assertInstanceOf(ResumeClaim.class, store.submitResult(group, result("call")).blockingGet());
    }

    @Test
    void rejectsDuplicateResultWhenItsOfficialMessageIdentityDiffers() {
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        persist(store, group, "call", "tool");
        ToolResultNormalizer normalizer = new ToolResultNormalizer();

        store.submitResult(scope, ConsumedToolResult.from(
                new com.agui.community.core.message.ToolMessage("one", "{}", "call"), normalizer)).blockingGet();

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> store.submitResult(scope, ConsumedToolResult.from(
                        new com.agui.community.core.message.ToolMessage("two", "{}", "call"), normalizer)).blockingGet())
                .hasMessageContaining("conflicting duplicate tool result");
    }

    @Test
    void readyClaimRetainsExactOriginalBrowserToolMessageForReservation() {
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        persist(store, group, "call", "tool");
        com.agui.community.core.message.ToolMessage original =
                new com.agui.community.core.message.ToolMessage("browser-message", "{\"value\":1}", "call");

        ResumeClaim claim = (ResumeClaim) store.submitResult(
                scope, ConsumedToolResult.from(original, new ToolResultNormalizer())).blockingGet();

        org.assertj.core.api.Assertions.assertThat(claim.originalMessages()).containsExactly(original);
    }

    @Test
    void retainsConsumedResultAfterCompletionForDeterministicHistoryClassification() {
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        persist(store, group, "call", "tool");
        ResumeClaim claim = (ResumeClaim) store.submitResult(group, result("call")).blockingGet();

        store.complete(claim).blockingAwait();

        org.assertj.core.api.Assertions.assertThat(store.consumed(scope)).containsKey("call");
    }

    private static NormalizedToolResult result(String id) {
        return new NormalizedToolResult(id, java.util.Map.of("result", id));
    }

    private static void persist(SessionPendingCallStore store, PendingCallGroupKey group, String id, String name) {
        store.persist(new PendingToolCall(new PendingCallKey(group, id),
                new ToolCallChunkEvent(id, name, "parent", "{}", 1L, null), "{}", PendingStatus.PENDING)).blockingAwait();
    }
}
