package com.agui.adk.hitl;

import com.agui.community.core.event.ToolCallChunkEvent;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

class CrossInstanceResultClaimTest {
    @Test
    void sharedStoreClaimsOneCompleteGroupWhenFinalSiblingResultsArriveSimultaneously() {
        SessionPendingCallStore sharedStore = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "session");
        PendingCallGroupKey group = new PendingCallGroupKey(scope, "turn");
        persist(sharedStore, group, "first");
        persist(sharedStore, group, "second");

        CompletableFuture<PendingResultTransition> first = CompletableFuture.supplyAsync(
                () -> sharedStore.submitResult(group, result("first")).blockingGet());
        CompletableFuture<PendingResultTransition> second = CompletableFuture.supplyAsync(
                () -> sharedStore.submitResult(group, result("second")).blockingGet());
        List<PendingResultTransition> transitions = List.of(first.join(), second.join());

        assertEquals(1, transitions.stream().filter(ResumeClaim.class::isInstance).count());
        assertEquals(1, transitions.stream().filter(BufferedToolResult.class::isInstance).count());
        ResumeClaim claim = transitions.stream()
                .filter(ResumeClaim.class::isInstance)
                .map(ResumeClaim.class::cast)
                .findFirst()
                .orElseThrow();
        assertEquals(List.of("first", "second"),
                claim.results().stream().map(result -> result.call().key().toolCallId()).toList());
        assertInstanceOf(PendingResultTransition.Duplicate.class,
                sharedStore.submitResult(group, result("first")).blockingGet());
    }

    private static NormalizedToolResult result(String id) {
        return new NormalizedToolResult(id, Map.of("result", id));
    }

    private static void persist(SessionPendingCallStore store, PendingCallGroupKey group, String id) {
        store.persist(new PendingToolCall(new PendingCallKey(group, id),
                new ToolCallChunkEvent(id, id + "-tool", "parent", "{}", 1L, null), "{}", PendingStatus.PENDING))
                .blockingAwait();
    }
}
