package com.agui.adk.history;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

import org.junit.jupiter.api.Test;

class LroResumeGatingTest {


    @Test
    void keepsSameTurnSiblingPendingWhenARealSecondCallIsPendingAndAnswers() {
        // pending: sibling s1 AND answered call c1. arriving answers c1; sibling shares the turn.
        Map<String, String> remap = Map.of("s1", "ps1", "c1", "pc1");
        Map<String, String> persistedToInvocation = Map.of("ps1", "inv-s", "pc1", "inv-c");
        // both s1 and c1 genuinely pending; this the arrival answers c1
        Set<String> pending = setOf("s1", "c1");
        Set<String> arriving = setOf("c1");
        Set<String> still = LroResumeGating.scopePendingToTurn(pending, arriving, remap,
                lookup(persistedToInvocation));
        // c1 answered; s1 has its own invocation distinct from the arriving turn -> orphaned/dropped.
        assertThat(still).isEmpty();
    }

    private static Set<String> setOf(String... vals) {
        return new HashSet<>(java.util.List.of(vals));
    }

    // FindInvocationId: maps a persisted id to an invocation; null means unresolved.
    private static Function<String, Optional<String>> lookup(Map<String, String> persistedToInvocation) {
        return persisted -> Optional.ofNullable(persistedToInvocation.get(persisted));
    }

    @Test
    void scopesToSharedTurnAndDropsOrphanedPending() {
        // pending: p1 (same turn), p2 (orphaned/leaked). arriving: a1, both invoke "inv-1".
        // remap: p1->persist-p1, a1->persist-a1, p2->persist-p2
        Map<String, String> remap = Map.of("p1", "persist-p1", "a1", "persist-a1", "p2", "persist-p2");
        Map<String, String> persistedToInvocation = Map.of(
                "persist-p1", "inv-1", "persist-a1", "inv-1", "persist-p2", "inv-999");
        Set<String> pending = setOf("p1", "p2");
        Set<String> arriving = setOf("a1", "a1"); // duplicate ok
        Set<String> still = LroResumeGating.scopePendingToTurn(pending, arriving, remap,
                lookup(persistedToInvocation));
        // a1 answered; p1 same invocation -> still pending; p2 orphaned -> dropped.
        assertThat(still).containsExactly("p1");
    }

    @Test
    void emptyWhenAllPendingIdsArriveThisTurn() {
        // The arrival answers the very call that was pending -> nothing remains pending.
        Map<String, String> remap = Map.of("p1", "persist-p1", "a1", "persist-a1");
        Map<String, String> persistedToInvocation = Map.of("persist-p1", "inv-1", "persist-a1", "inv-1");
        Set<String> still = LroResumeGating.scopePendingToTurn(setOf("p1"), setOf("p1"), remap,
                lookup(persistedToInvocation));
        assertThat(still).isEmpty();
    }

    @Test
    void keepsUnscopedSetWhenArrivingInvocationsUnresolved() {
        Set<String> still = LroResumeGating.scopePendingToTurn(setOf("p1"), setOf("a1"),
                Map.of(), lookup(Map.of()));
        assertThat(still).containsExactly("p1"); // unscoped, gate preserved
    }
}
