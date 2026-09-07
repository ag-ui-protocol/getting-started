package com.agui.adk.hitl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.agui.community.core.interrupt.Interrupt;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SessionInterruptStoreTest {
    private static final PendingCallScope SCOPE = new PendingCallScope("app", "user", "session");

    @Test
    void buffersPartialGroupAndClaimsOnlyOnceInPersistenceOrder() {
        SessionInterruptStore store = new SessionInterruptStore();
        List<PendingInterrupt> group = group("group", "one", "two");
        store.persistGroup(group).blockingAwait();

        InterruptSubmission partial = store.submit(
                        SCOPE, List.of(resume("two", ResumeStatus.RESOLVED, Map.of("value", 2))))
                .blockingGet();
        assertThat(partial).isInstanceOf(InterruptSubmission.Pending.class);
        assertThat(((InterruptSubmission.Pending) partial).outstanding())
                .extracting(Interrupt::id)
                .containsExactly("one");
        assertThat(store.outstanding(SCOPE).map(PendingInterrupt::interruptId).toList().blockingGet())
                .containsExactly("one");

        InterruptSubmission claimed = store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("value", 1))))
                .blockingGet();
        InterruptGroupClaim claim = ((InterruptSubmission.Claimed) claimed).claim();
        assertThat(claim.interrupts()).extracting(PendingInterrupt::interruptId)
                .containsExactly("one", "two");
        assertThat(store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("value", 1))))
                .blockingGet()).isInstanceOf(InterruptSubmission.Duplicate.class);
    }

    @Test
    void comparesCanonicalObjectFingerprintsAndRejectsConflictsWithoutMutation() {
        SessionInterruptStore store = new SessionInterruptStore();
        store.persistGroup(group("group", "one", "two")).blockingAwait();
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("b", 2);
        first.put("a", 1);
        store.submit(SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, first))).blockingGet();
        Map<String, Object> reordered = new LinkedHashMap<>();
        reordered.put("a", 1);
        reordered.put("b", 2);

        InterruptSubmission duplicate = store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, reordered)))
                .blockingGet();
        assertThat(duplicate).isInstanceOf(InterruptSubmission.Pending.class);
        assertThatThrownBy(() -> store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("a", 9))))
                .blockingGet())
                .hasMessage("conflicting duplicate resume");
        assertThat(store.outstanding(SCOPE).map(PendingInterrupt::interruptId).toList().blockingGet())
                .containsExactly("two");
    }

    @Test
    void cancellationAtomicallyTombstonesEverySibling() {
        SessionInterruptStore store = new SessionInterruptStore();
        store.persistGroup(group("group", "one", "two")).blockingAwait();
        store.submit(SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("ok", true))))
                .blockingGet();

        InterruptSubmission result = store.submit(
                        SCOPE, List.of(resume("two", ResumeStatus.CANCELLED, null)))
                .blockingGet();
        assertThat(((InterruptSubmission.Cancelled) result).cancelled())
                .extracting(Interrupt::id)
                .containsExactly("one", "two");
        assertThat(store.outstanding(SCOPE).toList().blockingGet()).isEmpty();
        assertThat(store.submit(SCOPE, List.of(resume("two", ResumeStatus.CANCELLED, null)))
                .blockingGet()).isInstanceOf(InterruptSubmission.Duplicate.class);
        assertThat(store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("ok", true))))
                .blockingGet()).isInstanceOf(InterruptSubmission.Duplicate.class);
        assertThatThrownBy(() -> store.submit(
                        SCOPE, List.of(resume("two", ResumeStatus.RESOLVED, Map.of())))
                .blockingGet())
                .hasMessage("conflicting duplicate resume");
    }

    @Test
    void finalizationMarkerSurvivesClaimReleaseAndRecoversWithoutNewDecision() {
        SessionInterruptStore store = new SessionInterruptStore();
        store.persistGroup(group("group", "one")).blockingAwait();
        InterruptGroupClaim first = ((InterruptSubmission.Claimed) store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("ok", true))))
                .blockingGet()).claim();
        store.markFinalizationPending(first).blockingAwait();
        store.releaseFinalization(first).blockingAwait();

        InterruptGroupClaim recovered = ((InterruptSubmission.Claimed) store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("ok", true))))
                .blockingGet()).claim();
        assertThat(store.finalizationPending(recovered).blockingGet()).isTrue();
        store.complete(recovered).blockingAwait();
        assertThat(store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("ok", true))))
                .blockingGet()).isInstanceOf(InterruptSubmission.Duplicate.class);
    }

    @Test
    void tombstonesExpireUsingInjectedClockAndCompactReleasesOpaqueId() {
        MutableClock clock = new MutableClock(Instant.parse("2025-01-01T00:00:00Z"));
        SessionInterruptStore store = new SessionInterruptStore(clock, Duration.ofMinutes(5));
        store.persistGroup(group("group", "one")).blockingAwait();
        InterruptGroupClaim claim = ((InterruptSubmission.Claimed) store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of())))
                .blockingGet()).claim();
        store.complete(claim).blockingAwait();
        clock.advance(Duration.ofMinutes(5));

        assertThat(store.compact()).isEqualTo(1);
        assertThatThrownBy(() -> store.submit(
                        SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of())))
                .blockingGet()).hasMessage("unknown interrupt");
        store.persistGroup(group("other", "one")).blockingAwait();
    }

    @Test
    void rejectsWrongScopeAndMixedGroupsWithoutAcceptingAnyDecision() {
        SessionInterruptStore store = new SessionInterruptStore();
        store.persistGroup(group("first", "one")).blockingAwait();
        store.persistGroup(group("second", "two")).blockingAwait();
        PendingCallScope attacker = new PendingCallScope("app", "other", "session");

        assertThatThrownBy(() -> store.submit(
                        attacker, List.of(resume("one", ResumeStatus.RESOLVED, Map.of())))
                .blockingGet()).hasMessage("unknown interrupt");
        assertThatThrownBy(() -> store.submit(SCOPE, List.of(
                        resume("one", ResumeStatus.RESOLVED, Map.of()),
                        resume("two", ResumeStatus.RESOLVED, Map.of())))
                .blockingGet()).hasMessage("resumes must belong to one interrupt group");
        assertThat(store.outstanding(SCOPE).map(PendingInterrupt::interruptId).toList().blockingGet())
                .containsExactly("one", "two");
    }

    @Test
    void simultaneousLastSiblingProducesExactlyOneClaim() throws Exception {
        SessionInterruptStore store = new SessionInterruptStore();
        store.persistGroup(group("group", "one", "two")).blockingAwait();
        store.submit(SCOPE, List.of(resume("one", ResumeStatus.RESOLVED, Map.of("value", 1))))
                .blockingGet();
        java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            java.util.List<java.util.concurrent.Future<InterruptSubmission>> results = List.of(
                    executor.submit(() -> {
                        start.await();
                        return store.submit(SCOPE, List.of(resume(
                                "two", ResumeStatus.RESOLVED, Map.of("value", 2)))).blockingGet();
                    }),
                    executor.submit(() -> {
                        start.await();
                        return store.submit(SCOPE, List.of(resume(
                                "two", ResumeStatus.RESOLVED, Map.of("value", 2)))).blockingGet();
                    }));
            start.countDown();
            List<InterruptSubmission> submissions = results.stream().map(future -> {
                try {
                    return future.get();
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            }).toList();
            assertThat(submissions).filteredOn(InterruptSubmission.Claimed.class::isInstance).hasSize(1);
            assertThat(submissions).filteredOn(InterruptSubmission.Duplicate.class::isInstance).hasSize(1);
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void lookupPreservesRequestedOrderAndHidesWrongPrincipal() {
        SessionInterruptStore store = new SessionInterruptStore();
        store.persistGroup(group("group", "one", "two")).blockingAwait();

        assertThat(store.lookup(SCOPE, List.of("two", "one")).blockingGet())
                .extracting(PendingInterrupt::interruptId).containsExactly("two", "one");
        PendingCallScope wrongPrincipal = new PendingCallScope("app", "attacker", "session");
        assertThatThrownBy(() -> store.lookup(wrongPrincipal, List.of("one")).blockingGet())
                .hasMessage("unknown interrupt");
    }

    private static List<PendingInterrupt> group(String invocation, String... ids) {
        PendingCallGroupKey group = new PendingCallGroupKey(SCOPE, invocation);
        return java.util.Arrays.stream(ids)
                .map(id -> new PendingInterrupt(
                        id,
                        InterruptKind.FRONTEND_TOOL,
                        group,
                        "run",
                        "tool-" + id,
                        "tool",
                        null,
                        new Interrupt(id, "tool_call", "Complete tool", "tool-" + id,
                                Map.of("type", "object"), null, null)))
                .toList();
    }

    private static Resume resume(String id, ResumeStatus status, Object payload) {
        return new Resume(id, status, payload);
    }

    private static final class MutableClock extends Clock {
        private Instant instant;

        private MutableClock(Instant instant) {
            this.instant = instant;
        }

        private void advance(Duration duration) {
            instant = instant.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return instant;
        }
    }
}
