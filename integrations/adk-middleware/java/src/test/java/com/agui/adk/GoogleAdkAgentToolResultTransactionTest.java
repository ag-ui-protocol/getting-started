package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.agent.Context;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GoogleAdkAgentToolResultTransactionTest {
    @Test
    void cancellationDuringFrontendRunnerReleasesClaimAndReservationForRetry() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        ResolvedSession session = resolvedSession();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        SessionPendingCallStore calls = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "principal", "session");
        calls.persist(new PendingToolCall(new PendingCallKey(new PendingCallGroupKey(scope, "turn"), "call"),
                new ToolCallChunkEvent("call", "frontend", "{}"), "{}", PendingStatus.PENDING)).blockingAwait();
        RecordingReservations reservations = new RecordingReservations();
        NeverThenEmptyRunner runner = new NeverThenEmptyRunner();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .pendingCallStore(calls)
                .messageReservationStore(reservations)
                .build();

        RecordingSubscriber first = subscribe(agent.run(input()));
        assertThat(runner.awaitFirstRun()).isTrue();
        first.cancel();

        runner.completeNormally();
        RecordingSubscriber retry = subscribe(agent.run(input()));
        assertThat(retry.await()).isTrue();

        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
    }

    @Test
    void cancellationWhileReservationIsBlockedReleasesClaimForExactRetry() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingFirstReservation reservations = new BlockingFirstReservation(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, Completable.defer(() -> {
            trace.add("append");
            return Completable.complete();
        }));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber cancelled = subscribe(agent.run(input(result)));
        assertThat(reservations.awaitFirstReserve()).isTrue();
        assertThat(trackedCalls.claims).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);
        assertThat(runner.runs).isZero();

        cancelled.cancel();

        assertThat(reservations.awaitFirstDispose()).isTrue();
        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(trackedCalls.releases).isEqualTo(1);

        RecordingSubscriber retry = subscribe(agent.run(input(result)));
        assertThat(retry.await()).isTrue();

        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(reservations.rollbacks).isZero();
        assertThat(trackedCalls.claims).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly("reserve", "reserve", "runner", "append", "commit");
    }

    @Test
    void resumedTranslatorConstructionFailureRetainsRollbackReleaseAndLeaseUntilExactRetry() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations = new BlockingRollbackReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        TrackingCoordinator coordinator = new TrackingCoordinator();
        java.util.concurrent.atomic.AtomicInteger translators = new java.util.concurrent.atomic.AtomicInteger();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .executionCoordinator(coordinator)
                .eventTranslatorFactory((thread, run, outputSchemaAgentNames) -> {
                    if (translators.incrementAndGet() == 1) {
                        throw new IllegalStateException("translator construction");
                    }
                    return com.agui.adk.translator.EventTranslatorFactory.INSTANCE.create(thread, run);
                })
                .pendingCallStore(trackedCalls)
                .messageReservationStore(reservations)
                .build();
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));
        assertThat(reservations.awaitRollback()).isTrue();
        assertThat(runner.runs).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(coordinator.closes).isZero();
        assertThat(failed.events).hasSize(1);

        reservations.completeRollback();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "ADK execution failure", "ADK_EXECUTION_FAILURE", null, null));
        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(coordinator.closes).isEqualTo(1);
        assertThat(trace).containsExactly("reserve", "rollback");
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(coordinator.closes).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
    }

    @Test
    void cancelledResumedTranslatorConstructionFailureRetainsRollbackReleaseAndLeaseUntilExactRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations = new BlockingRollbackReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        TrackingCoordinator coordinator = new TrackingCoordinator();
        java.util.concurrent.atomic.AtomicInteger translators = new java.util.concurrent.atomic.AtomicInteger();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .executionCoordinator(coordinator)
                .eventTranslatorFactory((thread, run, outputSchemaAgentNames) -> {
                    if (translators.incrementAndGet() == 1) {
                        throw new IllegalStateException("translator construction");
                    }
                    return com.agui.adk.translator.EventTranslatorFactory.INSTANCE.create(thread, run);
                })
                .pendingCallStore(trackedCalls)
                .messageReservationStore(reservations)
                .build();
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber cancelled = subscribe(agent.run(input(result)));
        assertThat(reservations.awaitRollback()).isTrue();
        cancelled.cancel();

        assertThat(trackedCalls.releases).isZero();
        assertThat(coordinator.closes).isZero();
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        reservations.completeRollback();

        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(coordinator.closes).isEqualTo(1);
        assertThat(trace).containsExactly("reserve", "rollback");
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(coordinator.closes).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
    }

    @Test
    void recoveryCommitFactoryFailureRetainsFinalizationPendingWithoutRerunningAdk() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        RecoveryFactoryFailureReservations reservations = new RecoveryFactoryFailureReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList()))
                .thenReturn(Completable.fromAction(() -> trace.add("append")));
        TrackingCoordinator coordinator = new TrackingCoordinator();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .executionCoordinator(coordinator)
                .pendingCallStore(trackedCalls)
                .messageReservationStore(reservations)
                .build();
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(trackedCalls.finalizationPendingMarks).isEqualTo(1);
        assertThat(trackedCalls.releases).isZero();

        RecordingSubscriber cancelledRecovery = subscribe(agent.run(input(result)));
        assertThat(reservations.awaitRecoveryRollback()).isTrue();
        cancelledRecovery.cancel();

        assertThat(runner.runs).isEqualTo(1);
        assertThat(trackedCalls.releases).isZero();
        assertThat(coordinator.closes).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        reservations.completeRecoveryRollback();

        assertThat(coordinator.closes).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);
        assertThat(trackedCalls.releases).isZero();

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(3);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(coordinator.closes).isEqualTo(3);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
    }

    @Test
    void commitFailureAfterDurableAppendFinishesCompletionOnRetryWithoutRerunningAdk() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        ResolvedSession session = resolvedSession();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        SessionPendingCallStore calls = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "principal", "session");
        calls.persist(new PendingToolCall(new PendingCallKey(new PendingCallGroupKey(scope, "turn"), "call"),
                new ToolCallChunkEvent("call", "frontend", "{}"), "{}", PendingStatus.PENDING)).blockingAwait();
        FailOnceCommitReservations reservations = new FailOnceCommitReservations();
        NeverThenEmptyRunner runner = new NeverThenEmptyRunner();
        runner.completeNormally();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .pendingCallStore(calls)
                .messageReservationStore(reservations)
                .build();

        RecordingSubscriber failed = subscribe(agent.run(input()));
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                // The translated stream completed (hence its STATE_SNAPSHOT) before persistence failed.
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(subscribe(agent.run(input())).await()).isTrue();

        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(calls.pending(scope).blockingIterable()).isEmpty();
    }

    @Test
    void cancellationDuringRecoveredFinalizationCommitsAndCompletesWithoutRerunningAdk() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRecoveryCommitReservations reservations = new BlockingRecoveryCommitReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, Completable.fromAction(() -> trace.add("append")));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(trackedCalls.finalizationPendingMarks).isEqualTo(1);
        assertThat(reservations.rollbacks).isEqualTo(1);

        RecordingSubscriber cancelled = subscribe(agent.run(input(result)));
        assertThat(reservations.awaitRecoveryCommit()).isTrue();
        cancelled.cancel();
        RecordingSubscriber contender = subscribe(agent.run(input(result)));

        assertThat(contender.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(trackedCalls.releases).isZero();
        assertThat(trackedCalls.completions).isZero();

        reservations.completeRecoveryCommit();

        assertThat(contender.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(2);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly("reserve", "runner", "append", "commit", "rollback", "reserve", "commit");
    }

    @Test
    void recoveryStateReadFailureRetainsFinalizationPendingWithoutRerunningAdk() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        FailOnceCompleteCalls trackedCalls = new FailOnceCompleteCalls(calls, trace);
        GoogleAdkAgent agent = agent(
                trackedCalls,
                reservations,
                runner,
                Completable.fromAction(() -> trace.add("append")));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        trackedCalls.failNextFinalizationPendingRead = true;
        RecordingSubscriber failedRead = subscribe(agent.run(input(result)));

        assertThat(failedRead.await()).isTrue();
        assertThat(failedRead.error).isNull();
        assertThat(failedRead.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(runner.runs).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        RecordingSubscriber recovered = subscribe(agent.run(input(result)));

        assertThat(recovered.await()).isTrue();
        assertThat(recovered.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(2);
        assertThat(trackedCalls.completions).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
    }

    @Test
    void cancellationDuringRecoveryStateReadReleasesOwnershipBeforeLaterRecovery() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        BlockingRecoveryStateCalls trackedCalls = new BlockingRecoveryStateCalls(calls, trace);
        GoogleAdkAgent agent = agent(
                trackedCalls,
                reservations,
                runner,
                Completable.fromAction(() -> trace.add("append")));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        RecordingSubscriber cancelled = subscribe(agent.run(input(result)));
        assertThat(trackedCalls.awaitRecoveryRead()).isTrue();
        cancelled.cancel();
        assertThat(trackedCalls.awaitRelease()).isTrue();

        RecordingSubscriber contender = subscribe(agent.run(input(result)));
        assertThat(contender.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        trackedCalls.completeRelease();
        assertThat(trackedCalls.releases).isEqualTo(1);

        RecordingSubscriber recovered = subscribe(agent.run(input(result)));
        assertThat(recovered.await()).isTrue();
        assertThat(recovered.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
    }

    @Test
    void finalizationCompletionOwnershipPreventsSecondConsumerFromResumingWhileUnresolved()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        BlockingCompletePendingCalls trackedCalls = new BlockingCompletePendingCalls(calls, trace);
        GoogleAdkAgent owner = agent(
                trackedCalls,
                reservations,
                runner,
                Completable.fromAction(() -> trace.add("append")));
        GoogleAdkAgent contender = agent(
                trackedCalls,
                reservations,
                runner,
                Completable.fromAction(() -> trace.add("unexpected-append")));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber owningRun = subscribe(owner.run(input(result)));
        assertThat(trackedCalls.awaitCompletion()).isTrue();
        assertThat(owningRun.terminal()).isFalse();

        RecordingSubscriber competingRun = subscribe(contender.run(input(result)));

        assertThat(competingRun.await()).isTrue();
        assertThat(competingRun.error).isNull();
        assertThat(competingRun.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunFinishedEvent("thread", "run", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.completionAttempts).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        trackedCalls.completeCompletion();

        assertThat(owningRun.await()).isTrue();
        assertThat(owningRun.error).isNull();
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly("reserve", "runner", "append", "commit", "complete");
    }

    @Test
    void synchronousRecoveryReleaseFactoryFailureDoesNotStrandExecutionLease() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        FailOnceCompleteCalls trackedCalls = new FailOnceCompleteCalls(calls, trace);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner,
                Completable.fromAction(() -> trace.add("append")));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        trackedCalls.throwNextReleaseFinalization = true;

        RecordingSubscriber factoryFailure = subscribe(agent.run(input(result)));
        assertThat(factoryFailure.await()).isTrue();
        assertThat(factoryFailure.error).isNull();
        assertThat(factoryFailure.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));

        RecordingSubscriber recovered = subscribe(agent.run(input(result)));
        assertThat(recovered.await()).isTrue();
        assertThat(recovered.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
    }

    @Test
    void finalizationMarkerFailureReleasesClaimForFingerprintRecoveryWithoutRerunningAdk()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        EmptyAfterFirstReservation reservations = new EmptyAfterFirstReservation(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        FailOnceCompleteCalls trackedCalls = new FailOnceCompleteCalls(calls, trace);
        trackedCalls.failNextComplete = false;
        trackedCalls.failNextFinalizationPendingMark = true;
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner,
                Completable.fromAction(() -> trace.add("append")));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                // The translated stream completed (hence its STATE_SNAPSHOT) before persistence failed.
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));

        RecordingSubscriber recovered = subscribe(agent.run(input(result)));

        assertThat(recovered.await()).isTrue();
        assertThat(recovered.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
    }

    @Test
    void completionFailureAfterAppendAndCommitFinishesRecoveryWithoutRerunningAdk() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        FailOnceCompleteCalls trackedCalls = new FailOnceCompleteCalls(calls, trace);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, Completable.defer(() -> {
            trace.add("append");
            return Completable.complete();
        }));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                // The translated stream completed (hence its STATE_SNAPSHOT) before persistence failed.
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(trace).containsExactly("reserve", "runner", "append", "commit", "complete", "rollback");
        assertThat(calls.consumed(scope())).isEmpty();

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();

        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(2);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly(
                "reserve", "runner", "append", "commit", "complete", "rollback", "reserve", "commit", "complete");
    }

    @Test
    void publicRunRejectsFrontendResultsAcrossPendingGroupsWithCanonicalPendingCallsError()
            throws InterruptedException {
        SessionPendingCallStore calls =
                new SessionPendingCallStore();
        PendingCallGroupKey firstGroup =
                new PendingCallGroupKey(scope(), "turn-one");
        PendingCallGroupKey secondGroup =
                new PendingCallGroupKey(scope(), "turn-two");
        calls.persist(
                        new PendingToolCall(
                                new PendingCallKey(
                                        firstGroup,
                                        "first"),
                                new ToolCallChunkEvent(
                                        "first",
                                        "frontend",
                                        "{}"),
                                "{}",
                                PendingStatus.PENDING))
                .blockingAwait();
        calls.persist(
                        new PendingToolCall(
                                new PendingCallKey(
                                        secondGroup,
                                        "second"),
                                new ToolCallChunkEvent(
                                        "second",
                                        "frontend",
                                        "{}"),
                                "{}",
                                PendingStatus.PENDING))
                .blockingAwait();
        TransactionReservations reservations =
                new TransactionReservations(
                        new ArrayList<>());
        ScriptedRunner runner =
                new ScriptedRunner(
                        new ArrayList<>(),
                        Outcome.EMPTY);
        GoogleAdkAgent agent =
                agent(
                        calls,
                        reservations,
                        runner,
                        Completable.complete());

        RecordingSubscriber rejected =
                subscribe(
                        agent.run(
                                input(
                                        new ToolMessage(
                                                "first-result",
                                                "{}",
                                                "first"),
                                        new ToolMessage(
                                                "second-result",
                                                "{}",
                                                "second"))));

        assertThat(rejected.await()).isTrue();
        assertThat(rejected.error).isNull();
        assertThat(rejected.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Pending tool calls",
                                "PENDING_TOOL_CALLS",
                                null,
                                null));
        assertThat(runner.runs).isZero();
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(calls.pending(scope()).toList().blockingGet())
                .hasSize(2);
        assertThat(calls.consumed(scope())).isEmpty();
    }

    @Test
    void publicRunResumesCompleteSingleFrontendResultWithTrailingUserInOneExecution()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.complete());
        Message followUp = new com.agui.community.core.message.UserMessage("next-user", "continue");

        RecordingSubscriber resumed = subscribe(agent.run(input(
                new ToolMessage("browser-result", "{}", "call"), followUp)));

        assertThat(resumed.await()).isTrue();
        assertThat(resumed.events).noneMatch(com.agui.community.core.event.RunErrorEvent.class::isInstance);
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.reserved).singleElement().satisfies(messages -> {
            assertThat(messages).extracting(Message::id).containsExactly("browser-result", "next-user");
        });
        assertThat(runner.contents).singleElement().satisfies(content -> {
            List<Part> parts = content.parts().orElseThrow();
            assertThat(parts).hasSize(2);
            assertThat(parts.getFirst().functionResponse().orElseThrow().id()).contains("call");
            assertThat(parts.get(1).text()).contains("continue");
        });
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
    }

    @Test
    void publicRunResumesCompleteMultiCallGroupWithTrailingUserInOneExecution()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "first", "second");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.complete());

        RecordingSubscriber resumed = subscribe(agent.run(input(
                new ToolMessage("browser-second", "{\"second\":2}", "second"),
                new ToolMessage("browser-first", "{\"first\":1}", "first"),
                new com.agui.community.core.message.UserMessage("next-user", "summarize"))));

        assertThat(resumed.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.reserved.getFirst()).extracting(Message::id)
                .containsExactly("browser-first", "browser-second", "next-user");
        List<Part> parts = runner.contents.getFirst().parts().orElseThrow();
        assertThat(parts).hasSize(3);
        assertThat(parts.get(0).functionResponse().orElseThrow().id()).contains("first");
        assertThat(parts.get(1).functionResponse().orElseThrow().id()).contains("second");
        assertThat(parts.get(2).text()).contains("summarize");
    }

    @Test
    void publicRunRejectsTrailingUserWhileSameTurnGroupIsIncompleteWithoutMutation()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "first", "second");
        TransactionReservations reservations = new TransactionReservations(new ArrayList<>());
        ScriptedRunner runner = new ScriptedRunner(new ArrayList<>(), Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.complete());

        RecordingSubscriber rejected = subscribe(agent.run(input(
                new ToolMessage("browser-first", "{}", "first"),
                new com.agui.community.core.message.UserMessage("next-user", "continue"))));

        assertThat(rejected.await()).isTrue();
        assertThat(rejected.events).anyMatch(event -> event instanceof com.agui.community.core.event.RunErrorEvent error
                && "PENDING_TOOL_CALLS".equals(error.code()));
        assertThat(runner.runs).isZero();
        assertThat(reservations.reserved).isEmpty();
        assertThat(calls.acceptedResultIds(scope())).isEmpty();
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(2);
    }

    @Test
    void publicRunCompletesBufferedMultiCallGroupWithTrailingUser()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "first", "second");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.complete());

        assertThat(subscribe(agent.run(input(
                new ToolMessage("browser-first", "{\"first\":1}", "first")))).await()).isTrue();
        assertThat(runner.runs).isZero();
        RecordingSubscriber resumed = subscribe(agent.run(input(
                new ToolMessage("browser-second", "{\"second\":2}", "second"),
                new com.agui.community.core.message.UserMessage("next-user", "continue"))));

        assertThat(resumed.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(runner.contents.getFirst().parts().orElseThrow()).hasSize(3);
        assertThat(reservations.reserved.getFirst()).extracting(Message::id)
                .containsExactly("browser-first", "browser-second", "next-user");
    }

    @Test
    void publicRunCarriesCompleteResultAndFollowUpInsideThreeChunkRequest()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input(
                new com.agui.community.core.message.UserMessage("before", "before"),
                new ToolMessage("browser-result", "{}", "call"),
                new com.agui.community.core.message.UserMessage("follow-up", "continue"),
                new ToolMessage("historical", "{}", "server-call"),
                new com.agui.community.core.message.UserMessage("after", "after"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(runner.contents.get(1).parts().orElseThrow()).satisfies(parts -> {
            assertThat(parts).hasSize(2);
            assertThat(parts.getFirst().functionResponse()).isPresent();
            assertThat(parts.get(1).text()).contains("continue");
        });
        assertThat(reservations.reserved.get(1)).extracting(Message::id)
                .containsExactly("browser-result", "follow-up");
    }

    @Test
    void publicRunRejectsUnknownExactCallIdAlongsideCurrentFrontendResult()
            throws InterruptedException {
        SessionPendingCallStore calls =
                callsWith("turn", "current");
        TransactionReservations reservations =
                new TransactionReservations(
                        new ArrayList<>());
        ScriptedRunner runner =
                new ScriptedRunner(
                        new ArrayList<>(),
                        Outcome.EMPTY);
        GoogleAdkAgent agent =
                agent(
                        calls,
                        reservations,
                        runner,
                        Completable.complete());

        RecordingSubscriber rejected =
                subscribe(
                        agent.run(
                                input(
                                        new ToolMessage(
                                                "current-result",
                                                "{\"value\":1}",
                                                "current"),
                                        new ToolMessage(
                                                "mismatched-result",
                                                "{\"value\":1}",
                                                "unknown"))));

        assertThat(rejected.await()).isTrue();
        assertThat(rejected.error).isNull();
        assertThat(rejected.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Unknown tool result",
                                "UNKNOWN_TOOL_RESULT",
                                null,
                                null));
        assertThat(runner.runs).isZero();
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(calls.pending(scope()).toList().blockingGet())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();
    }

    @Test
    void partialSiblingBuffersWithoutStartingTheMessageTransaction() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "first", "second");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input(new ToolMessage("browser-first", "{\"one\":1}", "first"))));

        assertThat(subscriber.await()).isTrue();
        assertThat(reservations.reserved).isEmpty();
        assertThat(runner.runs).isZero();
        assertThat(trace).isEmpty();
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(2);
        assertThat(calls.consumed(scope())).isEmpty();
    }

    @Test
    void outOfOrderReadyGroupReservesOriginalBrowserMessagesInPersistedCallOrder() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "first", "second");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(calls, reservations, runner, Completable.defer(() -> {
            trace.add("append");
            return Completable.complete();
        }));
        ToolMessage second = new ToolMessage("browser-second", "{\"second\":2}", "second");
        ToolMessage first = new ToolMessage("browser-first", "{\"first\":1}", "first");

        RecordingSubscriber subscriber = subscribe(agent.run(input(second, first)));

        assertThat(subscriber.await()).isTrue();
        assertThat(reservations.reserved.getFirst().stream().map(Message::id).toList())
                .containsExactly("browser-first", "browser-second");
        assertThat(reservations.reserved.getFirst()).extracting(Message::content)
                .containsExactly("{\"first\":1}", "{\"second\":2}");
        assertThat(reservations.reserved.getFirst()).extracting(com.agui.adk.message.MessageFingerprint::of)
                .containsExactly(
                        com.agui.adk.message.MessageFingerprint.of(first),
                        com.agui.adk.message.MessageFingerprint.of(second));
        assertThat(trace).containsExactly("reserve", "runner", "append", "commit");
    }

    @Test
    void terminalSuccessCommitsConsumesAndSuppressesExactReplay() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        List<List<Message>> appended = new ArrayList<>();
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, Completable.defer(() -> {
            trace.add("append");
            return Completable.complete();
        }), appended);
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(subscribe(agent.run(input(result))).await()).isTrue();

        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(reservations.rollbacks).isZero();
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(calls.consumed(scope()).get("call").messageId()).isEqualTo("browser-result");
        assertThat(calls.consumed(scope()).get("call").fingerprint()).isEqualTo(
                com.agui.adk.message.MessageFingerprint.of(result));
        assertThat(appended).singleElement().extracting(messages -> messages.getFirst().id())
                .isEqualTo("browser-result");
        assertThat(com.agui.adk.message.MessageFingerprint.of(appended.getFirst().getFirst()))
                .isEqualTo(com.agui.adk.message.MessageFingerprint.of(result));
        assertThat(trace).containsExactly("reserve", "runner", "append", "commit");
    }

    @Test
    void publicRollbackFailureReleasesClaimAndAllowsExactRetry() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations = new BlockingRollbackReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.SYNC_THROW, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        GoogleAdkAgent agent = agent(
                trackedCalls,
                reservations,
                runner,
                Completable.defer(() -> {
                    trace.add("append");
                    return Completable.complete();
                }));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));

        assertThat(reservations.awaitRollback()).isTrue();
        reservations.failRollback();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "ADK execution failure", "ADK_EXECUTION_FAILURE", null, null));
        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        RecordingSubscriber retry = subscribe(agent.run(input(result)));

        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly(
                "reserve", "runner", "rollback", "reserve", "runner", "append", "commit");
    }

    @Test
    void publicRunnerFailureWaitsForDurableRollbackReleaseBeforeErrorAndExactRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations =
                new BlockingRollbackReservations(trace);
        ScriptedRunner runner =
                new ScriptedRunner(
                        trace,
                        Outcome.SYNC_THROW,
                        Outcome.EMPTY);
        TrackingPendingCalls trackedCalls =
                new TrackingPendingCalls(calls);
        GoogleAdkAgent agent =
                agent(
                        trackedCalls,
                        reservations,
                        runner,
                        Completable.defer(() -> {
                            trace.add("append");
                            return Completable.complete();
                        }));
        ToolMessage result =
                new ToolMessage(
                        "browser-result",
                        "{\"ok\":true}",
                        "call");

        RecordingSubscriber failed =
                subscribe(agent.run(input(result)));

        assertThat(reservations.awaitRollback()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(calls.pending(scope()).blockingIterable())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();

        RecordingSubscriber retry =
                subscribe(agent.run(input(result)));

        assertThat(retry.error).isNull();
        assertThat(retry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();

        reservations.completeRollback();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "ADK execution failure",
                                "ADK_EXECUTION_FAILURE",
                                null,
                                null));
        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable())
                .isEmpty();
        assertThat(calls.consumed(scope()))
                .containsOnlyKeys("call");
        assertThat(trace)
                .containsExactly(
                        "reserve",
                        "runner",
                        "rollback",
                        "reserve",
                        "runner",
                        "append",
                        "commit");
    }

    @Test
    void publicNonCodedResumedTranslatorFailureWaitsForRollbackAndDurableReleaseBeforeCanonicalErrorAndRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations = new BlockingRollbackReservations(trace);
        BlockingReleasePendingCalls trackedCalls = new BlockingReleasePendingCalls(calls, trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.FRONTEND_CALL, Outcome.EMPTY);
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(
                Completable.defer(() -> {
                    trace.add("append");
                    return Completable.complete();
                }));
        java.util.concurrent.atomic.AtomicInteger translators = new java.util.concurrent.atomic.AtomicInteger();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .eventTranslatorFactory((thread, run, outputSchemaAgentNames) -> {
                    if (translators.incrementAndGet() == 1) {
                        return new com.agui.adk.translator.EventTranslator(
                                new com.agui.adk.translator.TranslationContext(thread, run, List.of()),
                                List.of((event, context) -> Flowable.error(
                                        new IllegalStateException("non-coded translator failure"))));
                    }
                    return com.agui.adk.translator.EventTranslatorFactory.INSTANCE.create(thread, run);
                })
                .pendingCallStore(trackedCalls)
                .messageReservationStore(reservations)
                .build();
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));

        assertThat(reservations.awaitRollback()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).containsExactly(new com.agui.community.core.event.RunStartedEvent("thread", "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();

        RecordingSubscriber blockedRetry = subscribe(agent.run(input(result)));

        assertThat(blockedRetry.error).isNull();
        assertThat(blockedRetry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();

        reservations.completeRollback();

        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(failed.terminal()).isFalse();
        assertThat(blockedRetry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();

        trackedCalls.completeRelease();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "ADK execution failure", "ADK_EXECUTION_FAILURE", null, null));
        assertThat(failed.events.stream().filter(event -> event instanceof com.agui.community.core.event.RunErrorEvent
                || event instanceof com.agui.community.core.event.RunFinishedEvent).count()).isEqualTo(2);
        assertThat(blockedRetry.await()).isTrue();
        assertThat(blockedRetry.error).isNull();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly(
                "reserve", "runner", "rollback", "release", "reserve", "runner", "append", "commit");
    }

    @Test
    void publicAlreadyCodedResumedTerminalWaitsForRollbackAndDurableReleaseUnchangedBeforeRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations = new BlockingRollbackReservations(trace);
        BlockingReleasePendingCalls trackedCalls = new BlockingReleasePendingCalls(calls, trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.FRONTEND_CALL, Outcome.EMPTY);
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(
                Completable.defer(() -> {
                    trace.add("append");
                    return Completable.complete();
                }));
        java.util.concurrent.atomic.AtomicInteger translators = new java.util.concurrent.atomic.AtomicInteger();
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .eventTranslatorFactory((thread, run, outputSchemaAgentNames) -> {
                    if (translators.incrementAndGet() == 1) {
                        return new com.agui.adk.translator.EventTranslator(
                                new com.agui.adk.translator.TranslationContext(thread, run, List.of()),
                                List.of((event, context) -> Flowable.just(
                                        new com.agui.community.core.event.RunErrorEvent(
                                                "Provider policy denied continuation",
                                                "PROVIDER_POLICY_DENIED",
                                                1_754_500_123_456L,
                                                Map.of("provider", "policy-engine", "decision", "deny")))));
                    }
                    return com.agui.adk.translator.EventTranslatorFactory.INSTANCE.create(thread, run);
                })
                .pendingCallStore(trackedCalls)
                .messageReservationStore(reservations)
                .build();
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));

        assertThat(reservations.awaitRollback()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).containsExactly(new com.agui.community.core.event.RunStartedEvent("thread", "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(trackedCalls.completions).isZero();
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();

        RecordingSubscriber blockedRetry = subscribe(agent.run(input(result)));

        assertThat(blockedRetry.error).isNull();
        assertThat(blockedRetry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(trackedCalls.completions).isZero();

        reservations.completeRollback();

        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(failed.terminal()).isFalse();
        assertThat(blockedRetry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.completions).isZero();

        trackedCalls.completeRelease();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "Provider policy denied continuation",
                        "PROVIDER_POLICY_DENIED",
                        1_754_500_123_456L,
                        Map.of("provider", "policy-engine", "decision", "deny")));
        assertThat(failed.events.stream().filter(event -> event instanceof com.agui.community.core.event.RunErrorEvent
                || event instanceof com.agui.community.core.event.RunFinishedEvent).count()).isEqualTo(2);
        assertThat(blockedRetry.await()).isTrue();
        assertThat(blockedRetry.error).isNull();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly(
                "reserve", "runner", "rollback", "release", "reserve", "runner", "append", "commit");
    }

    @Test
    void publicResumeEncodingErrorWaitsForDurableRollbackReleaseAndPreservesExactCodeBeforeRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingRollbackReservations reservations =
                new BlockingRollbackReservations(trace);
        ScriptedRunner runner =
                new ScriptedRunner(
                        trace,
                        Outcome.FRONTEND_CALL,
                        Outcome.EMPTY);
        TrackingPendingCalls trackedCalls =
                new TrackingPendingCalls(calls);
        CanonicalEventEncoder encoder = ignored -> {
            throw new IllegalArgumentException(
                    "cannot encode resumed frontend call");
        };
        GoogleAdkAgent agent =
                agentWithEncoder(
                        trackedCalls,
                        reservations,
                        runner,
                        Completable.defer(() -> {
                            trace.add("append");
                            return Completable.complete();
                        }),
                        encoder);
        ToolMessage result =
                new ToolMessage(
                        "browser-result",
                        "{\"ok\":true}",
                        "call");

        RecordingSubscriber failed =
                subscribe(agent.run(frontendInput(result)));

        assertThat(reservations.awaitRollback()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(calls.pending(scope()).blockingIterable())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();

        RecordingSubscriber retry =
                subscribe(agent.run(frontendInput(result)));

        assertThat(retry.error).isNull();
        assertThat(retry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();

        reservations.completeRollback();

        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Event encoding failed",
                                "ENCODING_ERROR",
                                null,
                                null));
        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable())
                .isEmpty();
        assertThat(calls.consumed(scope()))
                .containsOnlyKeys("call");
        assertThat(trace)
                .containsExactly(
                        "reserve",
                        "runner",
                        "rollback",
                        "reserve",
                        "runner",
                        "append",
                        "commit");
    }

    @Test
    void publicResumePersistenceErrorWaitsForDurableRollbackReleaseAndPreservesExactCodeBeforeRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        FailingResumedPersistencePendingCalls failingCalls =
                new FailingResumedPersistencePendingCalls(calls, trace);
        BlockingRollbackReservations reservations =
                new BlockingRollbackReservations(trace);
        ScriptedRunner runner =
                new ScriptedRunner(
                        trace,
                        Outcome.FRONTEND_CALL,
                        Outcome.EMPTY);
        TrackingPendingCalls trackedCalls =
                new TrackingPendingCalls(failingCalls);
        GoogleAdkAgent agent =
                agentWithEncoder(
                        trackedCalls,
                        reservations,
                        runner,
                        Completable.defer(() -> {
                            trace.add("append");
                            return Completable.complete();
                        }),
                        event -> new EncodedEvent(
                                event,
                                "{\"type\":\"TOOL_CALL_CHUNK\","
                                        + "\"toolCallId\":\""
                                        + event.toolCallId()
                                        + "\",\"toolCallName\":\""
                                        + event.toolCallName()
                                        + "\",\"delta\":\"{}\"}"));
        ToolMessage result =
                new ToolMessage(
                        "browser-result",
                        "{\"ok\":true}",
                        "call");

        RecordingSubscriber failed =
                subscribe(agent.run(frontendInput(result)));

        assertThat(failingCalls.awaitPersistence()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();

        failingCalls.failPersistence();

        assertThat(reservations.awaitRollback()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.terminal()).isFalse();
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(calls.pending(scope()).blockingIterable())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();

        RecordingSubscriber retry =
                subscribe(agent.run(frontendInput(result)));

        assertThat(retry.error).isNull();
        assertThat(retry.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(trackedCalls.releases).isZero();

        reservations.completeRollback();

        assertThat(trackedCalls.awaitRelease()).isTrue();
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Persistence failure",
                                "PERSISTENCE_FAILURE",
                                null,
                                null));
        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable())
                .isEmpty();
        assertThat(calls.consumed(scope()))
                .containsOnlyKeys("call");
        assertThat(trace)
                .containsExactly(
                        "reserve",
                        "runner",
                        "persist",
                        "rollback",
                        "reserve",
                        "runner",
                        "append",
                        "commit");
    }

    @Test
    void synchronousRunnerThrowRollsBackReleasesAndRetriesOnce() throws InterruptedException {
        assertRunnerFailureRecovers(Outcome.SYNC_THROW);
    }

    @Test
    void asynchronousRunnerErrorRollsBackReleasesAndRetriesOnce() throws InterruptedException {
        assertRunnerFailureRecovers(Outcome.ASYNC_ERROR);
    }

    @Test
    void synchronousFreshMessageRunnerConstructionRollsBackBeforeExactRetry() throws InterruptedException {
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.SYNC_THROW, Outcome.EMPTY);
        GoogleAdkAgent agent = agent(new SessionPendingCallStore(), reservations, runner, Completable.fromAction(() -> trace.add("append")));

        RecordingSubscriber failed = subscribe(agent.run(userInput()));
        assertThat(failed.await()).isTrue();
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isZero();

        assertThat(subscribe(agent.run(userInput())).await()).isTrue();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trace).containsExactly("reserve", "runner", "rollback", "reserve", "runner", "append", "commit");
    }

    @Test
    void appendFailureAfterRunnerSuccessRollsBackReleasesAndRerunsCoherently() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY, Outcome.EMPTY);
        java.util.concurrent.atomic.AtomicInteger appends = new java.util.concurrent.atomic.AtomicInteger();
        Completable append = Completable.defer(() -> {
            trace.add("append");
            return appends.incrementAndGet() == 1
                    ? Completable.error(new IllegalStateException("append failed"))
                    : Completable.complete();
        });
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, append);
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                // The translated stream completed (hence its STATE_SNAPSHOT) before persistence failed.
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(calls.consumed(scope())).isEmpty();
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.finalizationPendingMarks).isZero();
        assertThat(trackedCalls.completions).isZero();

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly("reserve", "runner", "append", "rollback", "reserve", "runner", "append", "commit");
    }

    @Test
    void emptyReservationFinalizationFailureEmitsCodedPersistenceErrorWithoutRunnerExecution()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        EmptyReservationStore reservations = new EmptyReservationStore();
        ScriptedRunner runner = new ScriptedRunner(new ArrayList<>(), Outcome.EMPTY);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner,
                Completable.error(new IllegalStateException("append failed")));

        RecordingSubscriber failed = subscribe(agent.run(input()));

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(reservations.reserves).isEqualTo(1);
        assertThat(reservations.reservedMessages).isEmpty();
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(runner.runs).isZero();
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);
    }

    @Test
    void cancellationWhileProcessedAppendIsBlockedRetainsTransactionUntilDurableCompletion() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        BlockingAppend append = new BlockingAppend(trace);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, append.completable());
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber cancelled = subscribe(agent.run(input(result)));
        assertThat(append.awaitStarted()).isTrue();
        cancelled.cancel();
        RecordingSubscriber contender = subscribe(agent.run(input(result)));

        assertThat(contender.terminal()).isFalse();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);

        append.complete();

        assertThat(contender.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(reservations.rollbacks).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly("reserve", "runner", "append", "commit");
    }

    @Test
    void cancellationWhileProcessedAppendFailsReleasesTransactionForOneDeterministicRetry() throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, Outcome.EMPTY, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        BlockingAppend append = new BlockingAppend(trace);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, append.completable());
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber cancelled = subscribe(agent.run(input(result)));
        assertThat(append.awaitStarted()).isTrue();
        cancelled.cancel();
        RecordingSubscriber retry = subscribe(agent.run(input(result)));
        assertThat(retry.terminal()).isFalse();

        append.fail();

        assertThat(retry.await()).isTrue();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(trackedCalls.releases).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly(
                "reserve", "runner", "append", "rollback", "reserve", "runner", "append", "commit");
    }

    @Test
    void independentAgentsAtomicallyClaimOverlappingFinalSiblingsOnlyOnce() throws InterruptedException {
        SessionPendingCallStore sharedStore = callsWith("turn", "first", "second");
        CompletableSubjectGate firstSubmission = new CompletableSubjectGate();
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(
                new FirstSubmissionGateCalls(sharedStore, firstSubmission));
        List<String> trace = new ArrayList<>();
        TransactionReservations sharedReservations = new TransactionReservations(trace);
        BlockingRunner sharedRunner = new BlockingRunner(trace);
        SessionManager sharedSessions = mock(SessionManager.class);
        when(sharedSessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sharedSessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sharedSessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenAnswer(invocation -> {
            trace.add("append");
            return Completable.complete();
        });
        GoogleAdkAgent firstAgent = liveAgent(sharedSessions, trackedCalls, sharedReservations, sharedRunner);
        GoogleAdkAgent secondAgent = liveAgent(sharedSessions, trackedCalls, sharedReservations, sharedRunner);
        ToolMessage first = new ToolMessage("browser-first", "{\"first\":1}", "first");
        ToolMessage second = new ToolMessage("browser-second", "{\"second\":2}", "second");

        RecordingSubscriber firstSibling = subscribe(firstAgent.run(input(first)));
        assertThat(firstSubmission.awaitStarted()).isTrue();
        RecordingSubscriber secondSibling = subscribe(secondAgent.run(input(second)));
        assertThat(secondSibling.await()).isTrue();
        assertThat(sharedRunner.runs).isZero();

        firstSubmission.complete();
        assertThat(sharedRunner.awaitStarted()).isTrue();

        assertThat(trackedCalls.claims).isEqualTo(1);
        assertThat(trackedCalls.completions).isZero();
        assertThat(trackedCalls.releases).isZero();
        assertThat(sharedReservations.reserved).hasSize(1);
        assertThat(sharedReservations.commits).isZero();
        assertThat(callsWithPending(sharedStore)).isEqualTo(2);

        sharedRunner.complete();
        assertThat(firstSibling.await()).isTrue();
        assertThat(sharedRunner.runs).isEqualTo(1);
        assertThat(trackedCalls.claims).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(trackedCalls.releases).isZero();
        assertThat(sharedReservations.commits).isEqualTo(1);
        assertThat(callsWithPending(sharedStore)).isZero();
        assertThat(sharedStore.consumed(scope())).containsOnlyKeys("first", "second");

        assertThat(subscribe(secondAgent.run(input(second))).await()).isTrue();
        assertThat(sharedRunner.runs).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
    }

    @Test
    void cancellingToolResultBeforePendingReadSettlesReleasesOrdinaryLeaseForSameKeyRun() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GatedPendingCalls calls = new GatedPendingCalls(callsWith("turn", "call"));
        RecordingInProcessCoordinator coordinator = new RecordingInProcessCoordinator();
        TransactionReservations reservations = new TransactionReservations(new ArrayList<>());
        ScriptedRunner runner = new ScriptedRunner(new ArrayList<>(), Outcome.EMPTY);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .executionCoordinator(coordinator)
                .pendingCallStore(calls)
                .messageReservationStore(reservations)
                .build();

        RecordingSubscriber cancelled = subscribe(agent.run(input(new ToolMessage("browser-result", "{}", "call"))));
        assertThat(calls.awaitPending()).isTrue();
        assertThat(runner.runs).isZero();
        assertThat(reservations.reserved).isEmpty();
        assertThat(calls.claims).isZero();
        assertThat(calls.releases).isZero();
        assertThat(calls.completions).isZero();

        cancelled.cancel();
        assertThat(calls.pendingGate.hasObservers()).isFalse();

        RecordingSubscriber retry = subscribe(agent.run(userInput()));
        assertThat(retry.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(coordinator.closes).isEqualTo(2);
        assertThat(reservations.rollbacks).isZero();
        assertThat(calls.claims).isZero();
        assertThat(calls.releases).isZero();
        assertThat(calls.completions).isZero();

        calls.pendingGate.onComplete();
    }

    @Test
    void publicInitialPendingReadFailureEmitsExactPersistenceErrorWithoutTransactionAndAllowsRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        FailOncePendingReadCalls failingCalls =
                new FailOncePendingReadCalls(calls);
        TransactionReservations reservations =
                new TransactionReservations(trace);
        ScriptedRunner runner =
                new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent =
                agent(
                        failingCalls,
                        reservations,
                        runner,
                        Completable.defer(() -> {
                            trace.add("append");
                            return Completable.complete();
                        }));
        ToolMessage result =
                new ToolMessage("browser-result", "{}", "call");

        RecordingSubscriber failed =
                subscribe(agent.run(input(result)));

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Persistence failure",
                                "PERSISTENCE_FAILURE",
                                null,
                                null));
        assertThat(runner.runs).isZero();
        assertThat(reservations.reserved).isEmpty();
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(failingCalls.claims).isZero();
        assertThat(failingCalls.releases).isZero();
        assertThat(failingCalls.completions).isZero();
        assertThat(calls.pending(scope()).blockingIterable())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();
        assertThat(trace).isEmpty();

        RecordingSubscriber retry =
                subscribe(agent.run(input(result)));

        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.reserved).hasSize(1);
        assertThat(reservations.rollbacks).isZero();
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(failingCalls.claims).isEqualTo(1);
        assertThat(failingCalls.releases).isZero();
        assertThat(failingCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable())
                .isEmpty();
        assertThat(calls.consumed(scope()))
                .containsOnlyKeys("call");
        assertThat(trace)
                .containsExactly(
                        "reserve",
                        "runner",
                        "append",
                        "commit");
    }

    @Test
    void publicClaimSizeFailureWaitsForDurableReleaseBeforeExactPersistenceErrorAndRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingClaimSizeFailureCalls failingCalls =
                new BlockingClaimSizeFailureCalls(calls, trace);
        TransactionReservations reservations =
                new TransactionReservations(trace);
        ScriptedRunner runner =
                new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent =
                agent(
                        failingCalls,
                        reservations,
                        runner,
                        Completable.defer(() -> {
                            trace.add("append");
                            return Completable.complete();
                        }));
        ToolMessage result =
                new ToolMessage("browser-result", "{}", "call");

        RecordingSubscriber failed =
                subscribe(agent.run(input(result)));

        assertThat(failingCalls.awaitRelease()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(runner.runs).isZero();
        assertThat(reservations.reserved).isEmpty();
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(failingCalls.releases).isZero();
        assertThat(calls.pending(scope()).blockingIterable())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();

        RecordingSubscriber retry =
                subscribe(agent.run(input(result)));

        assertThat(retry.error).isNull();
        assertThat(retry.terminal()).isFalse();
        assertThat(runner.runs).isZero();
        assertThat(reservations.reserved).isEmpty();
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(failingCalls.releases).isZero();

        failingCalls.completeRelease();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Persistence failure",
                                "PERSISTENCE_FAILURE",
                                null,
                                null));
        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.reserved).hasSize(1);
        assertThat(reservations.rollbacks).isZero();
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(failingCalls.releases).isEqualTo(1);
        assertThat(failingCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable())
                .isEmpty();
        assertThat(calls.consumed(scope()))
                .containsOnlyKeys("call");
        assertThat(trace)
                .containsExactly(
                        "release",
                        "reserve",
                        "runner",
                        "append",
                        "commit");
    }

    @Test
    void publicFinalizationPendingReadFailureWaitsForDurableReleaseBeforeExactPersistenceErrorAndRetry()
            throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        BlockingFinalizationStateFailureCalls failingCalls =
                new BlockingFinalizationStateFailureCalls(calls, trace);
        TransactionReservations reservations =
                new TransactionReservations(trace);
        ScriptedRunner runner =
                new ScriptedRunner(trace, Outcome.EMPTY);
        GoogleAdkAgent agent =
                agent(
                        failingCalls,
                        reservations,
                        runner,
                        Completable.defer(() -> {
                            trace.add("append");
                            return Completable.complete();
                        }));

        RecordingSubscriber failed =
                subscribe(agent.run(input()));

        assertThat(failingCalls.awaitRelease()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"));
        assertThat(failed.terminal()).isFalse();
        assertThat(runner.runs).isZero();
        assertThat(reservations.commits).isZero();
        assertThat(failingCalls.releases).isZero();
        assertThat(calls.pending(scope()).blockingIterable())
                .hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();

        RecordingSubscriber retry =
                subscribe(agent.run(input()));

        assertThat(retry.error).isNull();
        assertThat(retry.terminal()).isFalse();
        assertThat(runner.runs).isZero();
        assertThat(reservations.reserved).isEmpty();
        assertThat(reservations.commits).isZero();
        assertThat(reservations.rollbacks).isZero();
        assertThat(failingCalls.releases).isZero();
        assertThat(failingCalls.completions).isZero();

        failingCalls.completeRelease();

        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events)
                .startsWith(
                        new com.agui.community.core.event.RunStartedEvent(
                                "thread",
                                "run"),
                        new com.agui.community.core.event.RunErrorEvent(
                                "Persistence failure",
                                "PERSISTENCE_FAILURE",
                                null,
                                null));
        assertThat(retry.await()).isTrue();
        assertThat(retry.error).isNull();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(reservations.rollbacks).isZero();
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(failingCalls.releases).isEqualTo(1);
        assertThat(failingCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable())
                .isEmpty();
        assertThat(calls.consumed(scope()))
                .containsOnlyKeys("call");
        assertThat(trace)
                .containsExactly(
                        "release",
                        "reserve",
                        "runner",
                        "append",
                        "commit");
    }

    @Test
    void ordinaryReservationFailureReleasesLeaseAndAllowsSameKeyRetry() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        TrackingCoordinator coordinator = new TrackingCoordinator();
        FailOnceReservations reservations = new FailOnceReservations();
        ScriptedRunner runner = new ScriptedRunner(new ArrayList<>(), Outcome.EMPTY);
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .executionCoordinator(coordinator)
                .pendingCallStore(new SessionPendingCallStore())
                .messageReservationStore(reservations)
                .build();

        RecordingSubscriber failed = subscribe(agent.run(userInput()));
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(coordinator.closes).isEqualTo(1);

        RecordingSubscriber retry = subscribe(agent.run(userInput()));
        assertThat(retry.await()).isTrue();
        assertThat(runner.runs).isEqualTo(1);
        assertThat(coordinator.closes).isEqualTo(2);
    }

    private static int callsWithPending(SessionPendingCallStore calls) {
        return (int) calls.pending(scope()).count().blockingGet().longValue();
    }

    private static GoogleAdkAgent liveAgent(
            SessionManager sessions, com.agui.adk.hitl.PendingCallStore calls,
            MessageReservationStore reservations, AdkRunnerClient runner) {
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .executionCoordinator(new com.agui.adk.execution.InProcessExecutionCoordinator())
                .pendingCallStore(calls)
                .messageReservationStore(reservations)
                .build();
    }

    private static void assertRunnerFailureRecovers(Outcome failure) throws InterruptedException {
        SessionPendingCallStore calls = callsWith("turn", "call");
        List<String> trace = new ArrayList<>();
        TransactionReservations reservations = new TransactionReservations(trace);
        ScriptedRunner runner = new ScriptedRunner(trace, failure, Outcome.EMPTY);
        TrackingPendingCalls trackedCalls = new TrackingPendingCalls(calls);
        GoogleAdkAgent agent = agent(trackedCalls, reservations, runner, Completable.defer(() -> {
            trace.add("append");
            return Completable.complete();
        }));
        ToolMessage result = new ToolMessage("browser-result", "{\"ok\":true}", "call");

        RecordingSubscriber failed = subscribe(agent.run(input(result)));
        assertThat(failed.await()).isTrue();
        assertThat(failed.error).isNull();
        assertThat(failed.events).startsWith(
                new com.agui.community.core.event.RunStartedEvent("thread", "run"),
                new com.agui.community.core.event.RunErrorEvent(
                        "ADK execution failure", "ADK_EXECUTION_FAILURE", null, null));
        assertThat(calls.pending(scope()).blockingIterable()).hasSize(1);
        assertThat(calls.consumed(scope())).isEmpty();
        assertThat(trackedCalls.releases).isEqualTo(1);

        assertThat(subscribe(agent.run(input(result))).await()).isTrue();
        assertThat(runner.runs).isEqualTo(2);
        assertThat(reservations.rollbacks).isEqualTo(1);
        assertThat(reservations.commits).isEqualTo(1);
        assertThat(trackedCalls.completions).isEqualTo(1);
        assertThat(calls.pending(scope()).blockingIterable()).isEmpty();
        assertThat(calls.consumed(scope())).containsOnlyKeys("call");
        assertThat(trace).containsExactly("reserve", "runner", "rollback", "reserve", "runner", "append", "commit");
    }

    private static PendingCallScope scope() {
        return new PendingCallScope("app", "principal", "session");
    }

    private static SessionPendingCallStore callsWith(String turn, String... callIds) {
        SessionPendingCallStore calls = new SessionPendingCallStore();
        PendingCallGroupKey group = new PendingCallGroupKey(scope(), turn);
        for (String callId : callIds) {
            calls.persist(new PendingToolCall(new PendingCallKey(group, callId),
                    new ToolCallChunkEvent(callId, "frontend", "{}"), "{}", PendingStatus.PENDING)).blockingAwait();
        }
        return calls;
    }

    private static GoogleAdkAgent agent(
            com.agui.adk.hitl.PendingCallStore calls, MessageReservationStore reservations,
            AdkRunnerClient runner, Completable append) {
        return agent(calls, reservations, runner, append, null);
    }

    private static GoogleAdkAgent agent(
            com.agui.adk.hitl.PendingCallStore calls, MessageReservationStore reservations,
            AdkRunnerClient runner, Completable append, List<List<Message>> durableAppends) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any())).thenReturn(Single.just(() -> {
        }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenAnswer(invocation -> {
            if (durableAppends != null) {
                durableAppends.add(List.copyOf(invocation.<List<Message>>getArgument(1)));
            }
            return append;
        });
        GoogleAdkAgent.Builder builder = GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .pendingCallStore(calls)
                .messageReservationStore(reservations);
        return builder.build();
    }

    private static GoogleAdkAgent agentWithEncoder(
            com.agui.adk.hitl.PendingCallStore calls,
            MessageReservationStore reservations,
            AdkRunnerClient runner,
            Completable append,
            CanonicalEventEncoder encoder) {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.acquireExecutionMutationGuard(any()))
                .thenReturn(Single.just(() -> {
                }));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(
                        any(),
                        anyList()))
                .thenReturn(append);
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .baseRunConfig(RunConfig.builder().build())
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(ignored -> "principal")
                .eventEncoder(encoder)
                .pendingCallStore(calls)
                .messageReservationStore(reservations)
                .build();
    }

    private static RunAgentInput input(Message... messages) {
        return new RunAgentInput("thread", "run", Map.of(), List.of(messages), List.of(),
                List.of(new Context("appName", "app")), Map.of());
    }

    private static RunAgentInput frontendInput(Message... messages) {
        return new RunAgentInput(
                "thread",
                "run",
                Map.of(),
                List.of(messages),
                List.of(new Tool(
                        "frontend",
                        "Frontend tool",
                        new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")),
                Map.of(
                        AdkRunExtensions.FORWARDED_PROPS_KEY,
                        Map.of(
                                "rawToolSchemas",
                                List.of(Map.of(
                                        "position", 0,
                                        "name", "frontend",
                                        "schema", Map.of("type", "object"))))));
    }

    private static RunAgentInput userInput() {
        return new RunAgentInput("thread", "run", Map.of(),
                List.of(new com.agui.community.core.message.UserMessage("user", "hello")), List.of(),
                List.of(new Context("appName", "app")), Map.of());
    }

    private enum Outcome { EMPTY, FRONTEND_CALL, SYNC_THROW, ASYNC_ERROR }

    private static final class BlockingFirstReservation implements MessageReservationStore {
        private final List<String> trace;
        private final CountDownLatch firstReserve = new CountDownLatch(1);
        private final CountDownLatch firstDispose = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.SingleSubject<MessageReservation> blocked =
                io.reactivex.rxjava3.subjects.SingleSubject.create();
        private int reserves;
        private int commits;
        private int rollbacks;

        private BlockingFirstReservation(List<String> trace) { this.trace = trace; }

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            trace.add("reserve");
            reserves++;
            MessageReservation reservation = new MessageReservation(session, messages, invocationId);
            if (reserves == 1) {
                firstReserve.countDown();
                return blocked.doOnDispose(firstDispose::countDown);
            }
            return Single.just(reservation);
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(() -> { commits++; trace.add("commit"); });
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> { rollbacks++; trace.add("rollback"); });
        }

        private boolean awaitFirstReserve() throws InterruptedException { return firstReserve.await(1, TimeUnit.SECONDS); }

        private boolean awaitFirstDispose() throws InterruptedException { return firstDispose.await(1, TimeUnit.SECONDS); }
    }

    private static final class BlockingRollbackReservations implements MessageReservationStore {
        private final List<String> trace;
        private final CountDownLatch rollbackStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject rollback =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int reserves;
        private int commits;
        private int rollbacks;

        private BlockingRollbackReservations(List<String> trace) { this.trace = trace; }
        @Override public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            trace.add("reserve");
            reserves++;
            return Single.just(new MessageReservation(session, messages, invocationId));
        }
        @Override public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(() -> { commits++; trace.add("commit"); });
        }
        @Override public Completable rollback(MessageReservation reservation) {
            rollbacks++;
            if (reserves == 1) {
                trace.add("rollback");
                rollbackStarted.countDown();
                return rollback;
            }
            return Completable.complete();
        }
        private boolean awaitRollback() throws InterruptedException { return rollbackStarted.await(1, TimeUnit.SECONDS); }
        private void completeRollback() { rollback.onComplete(); }
        private void failRollback() { rollback.onError(new IllegalStateException("rollback failed")); }
    }

    private static final class RecordingInProcessCoordinator implements com.agui.adk.execution.ExecutionCoordinator {
        private final com.agui.adk.execution.InProcessExecutionCoordinator delegate =
                new com.agui.adk.execution.InProcessExecutionCoordinator();
        private int closes;

        @Override
        public Single<com.agui.adk.execution.ExecutionLease> acquire(
                com.agui.adk.execution.ExecutionKey key,
                com.agui.adk.execution.CancellationToken cancellation) {
            return delegate.acquire(key, cancellation).map(lease -> () -> {
                closes++;
                lease.close();
            });
        }

        @Override public boolean isDistributed() { return false; }
    }

    private static final class GatedPendingCalls implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final CountDownLatch pendingStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject pendingGate =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int claims;
        private int releases;
        private int completions;

        private GatedPendingCalls(com.agui.adk.hitl.PendingCallStore delegate) {
            this.delegate = delegate;
        }

        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return Flowable.defer(() -> {
                pendingStarted.countDown();
                return pendingGate.toFlowable();
            });
        }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result).doOnSuccess(transition -> {
                if (transition instanceof com.agui.adk.hitl.ResumeClaim) {
                    claims++;
                }
            });
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim).doOnComplete(() -> releases++);
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim).doOnComplete(() -> completions++);
        }
        private boolean awaitPending() throws InterruptedException { return pendingStarted.await(1, TimeUnit.SECONDS); }
    }

    private static final class TrackingCoordinator implements com.agui.adk.execution.ExecutionCoordinator {
        private int closes;
        @Override public Single<com.agui.adk.execution.ExecutionLease> acquire(
                com.agui.adk.execution.ExecutionKey key,
                com.agui.adk.execution.CancellationToken cancellation) {
            return Single.just(() -> closes++);
        }
        @Override public boolean isDistributed() { return false; }
    }

    private static final class FailOnceReservations implements MessageReservationStore {
        private int reserves;

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            if (reserves++ == 0) {
                return Single.error(new IllegalStateException("reservation unavailable"));
            }
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.complete();
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.complete();
        }
    }

    private static final class EmptyAfterFirstReservation implements MessageReservationStore {
        private final List<String> trace;
        private int reserves;

        private EmptyAfterFirstReservation(List<String> trace) { this.trace = trace; }

        @Override
        public Single<MessageReservation> reserve(
                ResolvedSession session, List<Message> messages, String invocationId) {
            trace.add("reserve");
            List<Message> accepted = reserves++ == 0 ? messages : List.of();
            return Single.just(new MessageReservation(session, accepted, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(() -> trace.add("commit"));
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> trace.add("rollback"));
        }
    }

    private static final class TransactionReservations implements MessageReservationStore {
        private final List<String> trace;
        private final List<List<Message>> reserved = new ArrayList<>();
        private int commits;
        private int rollbacks;

        private TransactionReservations(List<String> trace) { this.trace = trace; }
        @Override public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            trace.add("reserve");
            reserved.add(List.copyOf(messages));
            return Single.just(new MessageReservation(session, messages, invocationId));
        }
        @Override public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(() -> { commits++; trace.add("commit"); });
        }
        @Override public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> { rollbacks++; trace.add("rollback"); });
        }
    }

    private static final class ScriptedRunner implements AdkRunnerClient {
        private final List<String> trace;
        private final java.util.ArrayDeque<Outcome> outcomes;
        private final List<Content> contents = new ArrayList<>();
        private int runs;

        private ScriptedRunner(List<String> trace, Outcome... outcomes) {
            this.trace = trace;
            this.outcomes = new java.util.ArrayDeque<>(List.of(outcomes));
        }
        @Override public String appName() { return "app"; }
        @Override public Flowable<com.google.adk.events.Event> runAsync(String userId, String sessionId, Content content,
                RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            contents.add(content);
            trace.add("runner");
            Outcome outcome = outcomes.removeFirst();
            if (outcome == Outcome.SYNC_THROW) {
                throw new IllegalStateException("synchronous runner failure");
            }
            if (outcome == Outcome.ASYNC_ERROR) {
                return Flowable.error(
                        new IllegalStateException(
                                "asynchronous runner failure"));
            }
            if (outcome == Outcome.FRONTEND_CALL) {
                return Flowable.just(
                        com.google.adk.events.Event.builder()
                                .author("model")
                                .content(Content.builder()
                                        .role("model")
                                        .parts(Part.builder()
                                                .functionCall(
                                                        FunctionCall.builder()
                                                                .id("new-call")
                                                                .name("frontend")
                                                                .args(Map.of())
                                                                .build())
                                                .build())
                                        .build())
                                .build());
            }
            return Flowable.empty();
        }
    }

    private static final class FailingResumedPersistencePendingCalls
            implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private final CountDownLatch persistenceStarted =
                new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject
                persistence =
                        io.reactivex.rxjava3.subjects.CompletableSubject
                                .create();
        private boolean failNextPersistence = true;

        private FailingResumedPersistencePendingCalls(
                com.agui.adk.hitl.PendingCallStore delegate,
                List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            if (!failNextPersistence) {
                return delegate.persist(call);
            }
            failNextPersistence = false;
            trace.add("persist");
            return persistence.doOnSubscribe(
                    ignored -> persistenceStarted.countDown());
        }

        @Override
        public Completable remove(
                PendingCallGroupKey group,
                Set<String> toolCallIds) {
            return delegate.remove(group, toolCallIds);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return delegate.pending(scope);
        }

        @Override
        public Map<String, com.agui.adk.hitl.ConsumedToolResult>
                consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }

        @Override
        public Single<com.agui.adk.hitl.PendingResultTransition>
                submitResult(
                        PendingCallScope scope,
                        com.agui.adk.hitl.ConsumedToolResult
                                result) {
            return delegate.submitResult(scope, result);
        }

        @Override
        public Completable release(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim);
        }

        @Override
        public Completable markFinalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }

        @Override
        public Single<Boolean> finalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }

        @Override
        public Completable complete(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim);
        }

        private boolean awaitPersistence() throws InterruptedException {
            return persistenceStarted.await(1, TimeUnit.SECONDS);
        }

        private void failPersistence() {
            persistence.onError(
                    new IllegalStateException("store unavailable"));
        }
    }

    private static final class FailOncePendingReadCalls
            implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private boolean failNextPendingRead = true;
        private int claims;
        private int releases;
        private int completions;

        private FailOncePendingReadCalls(
                com.agui.adk.hitl.PendingCallStore delegate) {
            this.delegate = delegate;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            return delegate.persist(call);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            if (failNextPendingRead) {
                failNextPendingRead = false;
                return Flowable.error(
                        new IllegalStateException("pending state unavailable"));
            }
            return delegate.pending(scope);
        }

        @Override
        public Map<String, com.agui.adk.hitl.ConsumedToolResult>
                consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }

        @Override
        public Single<com.agui.adk.hitl.PendingResultTransition>
                submitResult(
                        PendingCallScope scope,
                        com.agui.adk.hitl.ConsumedToolResult
                                result) {
            return delegate.submitResult(scope, result)
                    .doOnSuccess(transition -> {
                        if (transition instanceof com.agui.adk.hitl.ResumeClaim) {
                            claims++;
                        }
                    });
        }

        @Override
        public Completable release(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim)
                    .doOnComplete(() -> releases++);
        }

        @Override
        public Completable markFinalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }

        @Override
        public Single<Boolean> finalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }

        @Override
        public Completable complete(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim)
                    .doOnComplete(() -> completions++);
        }
    }

    private static final class BlockingClaimSizeFailureCalls
            implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private final CountDownLatch releaseStarted =
                new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject release =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private com.agui.adk.hitl.ResumeClaim activeClaim;
        private boolean failNextClaim = true;
        private int releases;
        private int completions;

        private BlockingClaimSizeFailureCalls(
                com.agui.adk.hitl.PendingCallStore delegate,
                List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            return delegate.persist(call);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return delegate.pending(scope);
        }

        @Override
        public Map<String, com.agui.adk.hitl.ConsumedToolResult>
                consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }

        @Override
        public Single<com.agui.adk.hitl.PendingResultTransition>
                submitResult(
                        PendingCallScope scope,
                        com.agui.adk.hitl.ConsumedToolResult
                                result) {
            return delegate.submitResult(scope, result)
                    .map(transition -> {
                        if (failNextClaim
                                && transition instanceof com.agui.adk.hitl.ResumeClaim claim) {
                            failNextClaim = false;
                            activeClaim = claim;
                            return new com.agui.adk.hitl.ResumeClaim(
                                    claim.group(),
                                    claim.results());
                        }
                        return transition;
                    });
        }

        @Override
        public Completable release(
                com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.defer(() -> {
                trace.add("release");
                releaseStarted.countDown();
                return release
                        .andThen(delegate.release(activeClaim))
                        .doOnComplete(() -> releases++);
            });
        }

        @Override
        public Completable markFinalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }

        @Override
        public Single<Boolean> finalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }

        @Override
        public Completable complete(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim)
                    .doOnComplete(() -> completions++);
        }

        private boolean awaitRelease() throws InterruptedException {
            return releaseStarted.await(1, TimeUnit.SECONDS);
        }

        private void completeRelease() {
            release.onComplete();
        }
    }

    private static final class BlockingFinalizationStateFailureCalls
            implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private final CountDownLatch releaseStarted =
                new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject release =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private boolean failNextFinalizationRead = true;
        private int releases;
        private int completions;

        private BlockingFinalizationStateFailureCalls(
                com.agui.adk.hitl.PendingCallStore delegate,
                List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override
        public Completable persist(PendingToolCall call) {
            return delegate.persist(call);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return delegate.pending(scope);
        }

        @Override
        public Map<String, com.agui.adk.hitl.ConsumedToolResult>
                consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }

        @Override
        public Single<com.agui.adk.hitl.PendingResultTransition>
                submitResult(
                        PendingCallScope scope,
                        com.agui.adk.hitl.ConsumedToolResult
                                result) {
            return delegate.submitResult(scope, result);
        }

        @Override
        public Completable release(
                com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.defer(() -> {
                trace.add("release");
                releaseStarted.countDown();
                return release
                        .andThen(delegate.release(claim))
                        .doOnComplete(() -> releases++);
            });
        }

        @Override
        public Completable markFinalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }

        @Override
        public Single<Boolean> finalizationPending(
                com.agui.adk.hitl.ResumeClaim claim) {
            if (failNextFinalizationRead) {
                failNextFinalizationRead = false;
                return Single.error(
                        new IllegalStateException(
                                "finalization state unavailable"));
            }
            return delegate.finalizationPending(claim);
        }

        @Override
        public Completable complete(
                com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim)
                    .doOnComplete(() -> completions++);
        }

        private boolean awaitRelease() throws InterruptedException {
            return releaseStarted.await(1, TimeUnit.SECONDS);
        }

        private void completeRelease() {
            release.onComplete();
        }
    }

    private static final class BlockingReleasePendingCalls implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private final CountDownLatch releaseStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject releaseGate =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int releases;
        private int completions;

        private BlockingReleasePendingCalls(
                com.agui.adk.hitl.PendingCallStore delegate, List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result);
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.defer(() -> {
                trace.add("release");
                releaseStarted.countDown();
                return releaseGate.andThen(delegate.release(claim)).doOnComplete(() -> releases++);
            });
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim).doOnComplete(() -> completions++);
        }
        private boolean awaitRelease() throws InterruptedException { return releaseStarted.await(1, TimeUnit.SECONDS); }
        private void completeRelease() { releaseGate.onComplete(); }
    }

    private static final class BlockingCompletePendingCalls
            implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private final CountDownLatch completionStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject completion =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int completionAttempts;

        private BlockingCompletePendingCalls(
                com.agui.adk.hitl.PendingCallStore delegate, List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result);
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim);
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }
        @Override public Completable releaseFinalization(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.releaseFinalization(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.defer(() -> {
                completionAttempts++;
                trace.add("complete");
                completionStarted.countDown();
                return completion.andThen(delegate.complete(claim));
            });
        }
        private boolean awaitCompletion() throws InterruptedException {
            return completionStarted.await(1, TimeUnit.SECONDS);
        }
        private void completeCompletion() { completion.onComplete(); }
    }

    private static final class BlockingRecoveryStateCalls
            implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private final CountDownLatch recoveryReadStarted = new CountDownLatch(1);
        private final CountDownLatch releaseStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject recoveryRead =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private final io.reactivex.rxjava3.subjects.CompletableSubject release =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private boolean blockNextRecoveryRead;
        private int completions;
        private int releases;

        private BlockingRecoveryStateCalls(
                com.agui.adk.hitl.PendingCallStore delegate, List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result);
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.defer(() -> {
                releaseStarted.countDown();
                return release.andThen(delegate.release(claim)).doOnComplete(() -> releases++);
            });
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            if (blockNextRecoveryRead) {
                blockNextRecoveryRead = false;
                recoveryReadStarted.countDown();
                return recoveryRead.andThen(delegate.finalizationPending(claim));
            }
            return delegate.finalizationPending(claim);
        }
        @Override public Completable releaseFinalization(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.releaseFinalization(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.defer(() -> {
                completions++;
                trace.add("complete");
                if (completions == 1) {
                    blockNextRecoveryRead = true;
                    return Completable.error(new IllegalStateException("complete failed"));
                }
                return delegate.complete(claim);
            });
        }
        private boolean awaitRecoveryRead() throws InterruptedException {
            return recoveryReadStarted.await(1, TimeUnit.SECONDS);
        }
        private boolean awaitRelease() throws InterruptedException {
            return releaseStarted.await(1, TimeUnit.SECONDS);
        }
        private void completeRelease() { release.onComplete(); }
    }

    private static final class TrackingPendingCalls implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private int releases;
        private int completions;
        private int claims;
        private int finalizationPendingMarks;
        private boolean failFinalizationPendingRead;
        private final CountDownLatch release = new CountDownLatch(1);

        private TrackingPendingCalls(com.agui.adk.hitl.PendingCallStore delegate) {
            this(delegate, false);
        }

        private TrackingPendingCalls(
                com.agui.adk.hitl.PendingCallStore delegate, boolean failFinalizationPendingRead) {
            this.delegate = delegate;
            this.failFinalizationPendingRead = failFinalizationPendingRead;
        }
        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result).doOnSuccess(transition -> {
                if (transition instanceof com.agui.adk.hitl.ResumeClaim) {
                    claims++;
                }
            });
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim).doOnComplete(() -> {
                releases++;
                release.countDown();
            });
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim).doOnComplete(() -> finalizationPendingMarks++);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            if (failFinalizationPendingRead) {
                failFinalizationPendingRead = false;
                return Single.error(new IllegalStateException("finalization state unavailable"));
            }
            return delegate.finalizationPending(claim);
        }
        @Override public Completable releaseFinalization(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.releaseFinalization(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim).doOnComplete(() -> completions++);
        }
        private boolean awaitRelease() throws InterruptedException { return release.await(1, TimeUnit.SECONDS); }
    }

    private static RunAgentInput input() {
        return new RunAgentInput("thread", "run", Map.of(),
                List.of(new ToolMessage("browser-result", "{}", "call")), List.of(),
                List.of(new Context("appName", "app")), Map.of());
    }

    private static ResolvedSession resolvedSession() {
        SessionMappingKey key = new SessionMappingKey("app", "principal", "thread");
        return new ResolvedSession(Session.builder("session").appName("app").userId("principal").state(Map.of()).build(),
                new SessionMapping(key, "session"));
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class EmptyReservationStore implements MessageReservationStore {
        private List<Message> reservedMessages = List.of();
        private int reserves;
        private int commits;
        private int rollbacks;

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            reserves++;
            reservedMessages = List.of();
            return Single.just(new MessageReservation(session, List.of(), invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(() -> commits++);
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> rollbacks++);
        }
    }

    private static final class RecordingReservations implements MessageReservationStore {
        private int rollbacks;
        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }
        @Override
        public Completable commit(MessageReservation reservation) { return Completable.complete(); }
        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> rollbacks++);
        }
    }

    private static final class FailOnceCommitReservations implements MessageReservationStore {
        private int commits;
        private int rollbacks;

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.fromAction(() -> {
                commits++;
                if (commits == 1) {
                    throw new IllegalStateException("commit failed");
                }
            });
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> rollbacks++);
        }
    }

    private static final class RecoveryFactoryFailureReservations implements MessageReservationStore {
        private final List<String> trace;
        private final CountDownLatch recoveryRollbackStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject recoveryRollback =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int commits;

        private RecoveryFactoryFailureReservations(List<String> trace) { this.trace = trace; }
        @Override public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            trace.add("reserve");
            return Single.just(new MessageReservation(session, messages, invocationId));
        }
        @Override public Completable commit(MessageReservation reservation) {
            commits++;
            trace.add("commit");
            if (commits == 1) {
                return Completable.error(new IllegalStateException("initial commit fails"));
            }
            if (commits == 2) {
                throw new IllegalStateException("recovery commit factory fails");
            }
            return Completable.complete();
        }
        @Override public Completable rollback(MessageReservation reservation) {
            if (commits == 2) {
                trace.add("rollback");
                recoveryRollbackStarted.countDown();
                return recoveryRollback;
            }
            trace.add("rollback");
            return Completable.complete();
        }
        private boolean awaitRecoveryRollback() throws InterruptedException {
            return recoveryRollbackStarted.await(1, TimeUnit.SECONDS);
        }
        private void completeRecoveryRollback() { recoveryRollback.onComplete(); }
    }

    private static final class BlockingRecoveryCommitReservations implements MessageReservationStore {
        private final List<String> trace;
        private final CountDownLatch recoveryCommitStarted = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject recoveryCommit =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int commits;
        private int rollbacks;

        private BlockingRecoveryCommitReservations(List<String> trace) { this.trace = trace; }

        @Override
        public Single<MessageReservation> reserve(ResolvedSession session, List<Message> messages, String invocationId) {
            trace.add("reserve");
            return Single.just(new MessageReservation(session, messages, invocationId));
        }

        @Override
        public Completable commit(MessageReservation reservation) {
            return Completable.defer(() -> {
                commits++;
                trace.add("commit");
                if (commits == 1) {
                    return Completable.error(new IllegalStateException("first commit fails"));
                }
                recoveryCommitStarted.countDown();
                return recoveryCommit;
            });
        }

        @Override
        public Completable rollback(MessageReservation reservation) {
            return Completable.fromAction(() -> { rollbacks++; trace.add("rollback"); });
        }

        private boolean awaitRecoveryCommit() throws InterruptedException {
            return recoveryCommitStarted.await(1, TimeUnit.SECONDS);
        }

        private void completeRecoveryCommit() { recoveryCommit.onComplete(); }
    }

    private static final class NeverThenEmptyRunner implements AdkRunnerClient {
        private final CountDownLatch started = new CountDownLatch(1);
        private boolean never = true;
        private int runs;
        @Override public String appName() { return "app"; }
        @Override public Flowable<com.google.adk.events.Event> runAsync(String userId, String sessionId, Content content,
                RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            started.countDown();
            return never ? Flowable.never() : Flowable.empty();
        }
        boolean awaitFirstRun() throws InterruptedException { return started.await(1, TimeUnit.SECONDS); }
        void completeNormally() { never = false; }
    }

    private static final class BlockingAppend {
        private final List<String> trace;
        private final CountDownLatch started = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject completion =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private final java.util.concurrent.atomic.AtomicInteger attempts = new java.util.concurrent.atomic.AtomicInteger();

        private BlockingAppend(List<String> trace) { this.trace = trace; }

        private Completable completable() {
            return Completable.defer(() -> {
                trace.add("append");
                started.countDown();
                return attempts.incrementAndGet() == 1 ? completion : Completable.complete();
            });
        }

        private boolean awaitStarted() throws InterruptedException { return started.await(1, TimeUnit.SECONDS); }

        private void complete() { completion.onComplete(); }

        private void fail() { completion.onError(new IllegalStateException("append failed")); }
    }

    private static final class CompletableSubjectGate {
        private final CountDownLatch started = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject gate =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();

        private Completable waitForRelease() {
            return Completable.defer(() -> {
                started.countDown();
                return gate;
            });
        }

        private boolean awaitStarted() throws InterruptedException { return started.await(1, TimeUnit.SECONDS); }

        private void complete() { gate.onComplete(); }
    }

    private static final class FirstSubmissionGateCalls implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final CompletableSubjectGate firstSubmission;

        private FirstSubmissionGateCalls(
                com.agui.adk.hitl.PendingCallStore delegate, CompletableSubjectGate firstSubmission) {
            this.delegate = delegate;
            this.firstSubmission = firstSubmission;
        }

        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return "first".equals(result.result().toolCallId())
                    ? firstSubmission.waitForRelease().andThen(delegate.submitResult(scope, result))
                    : delegate.submitResult(scope, result);
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim);
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.markFinalizationPending(claim);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.finalizationPending(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.complete(claim);
        }
    }

    private static final class BlockingRunner implements AdkRunnerClient {
        private final List<String> trace;
        private final CountDownLatch started = new CountDownLatch(1);
        private final io.reactivex.rxjava3.subjects.CompletableSubject completion =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private int runs;

        private BlockingRunner(List<String> trace) { this.trace = trace; }
        @Override public String appName() { return "app"; }
        @Override public Flowable<com.google.adk.events.Event> runAsync(String userId, String sessionId, Content content,
                RunConfig config, Map<String, Object> stateDelta) {
            runs++;
            trace.add("runner");
            started.countDown();
            return completion.toFlowable();
        }
        private boolean awaitStarted() throws InterruptedException { return started.await(1, TimeUnit.SECONDS); }
        private void complete() { completion.onComplete(); }
    }

    private static final class FailOnceCompleteCalls implements com.agui.adk.hitl.PendingCallStore {
        private final com.agui.adk.hitl.PendingCallStore delegate;
        private final List<String> trace;
        private int completions;
        private boolean failNextComplete = true;
        private boolean failNextFinalizationPendingRead;
        private boolean failNextFinalizationPendingMark;
        private boolean throwNextReleaseFinalization;

        private FailOnceCompleteCalls(com.agui.adk.hitl.PendingCallStore delegate, List<String> trace) {
            this.delegate = delegate;
            this.trace = trace;
        }

        @Override public Completable persist(PendingToolCall call) { return delegate.persist(call); }
        @Override public Flowable<PendingToolCall> pending(PendingCallScope scope) { return delegate.pending(scope); }
        @Override public Map<String, com.agui.adk.hitl.ConsumedToolResult> consumed(PendingCallScope scope) {
            return delegate.consumed(scope);
        }
        @Override public Single<com.agui.adk.hitl.PendingResultTransition> submitResult(
                PendingCallScope scope, com.agui.adk.hitl.ConsumedToolResult result) {
            return delegate.submitResult(scope, result);
        }
        @Override public Completable release(com.agui.adk.hitl.ResumeClaim claim) {
            return delegate.release(claim);
        }
        @Override public Completable markFinalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            if (failNextFinalizationPendingMark) {
                failNextFinalizationPendingMark = false;
                return Completable.error(new IllegalStateException("finalization mark failed"));
            }
            return delegate.markFinalizationPending(claim);
        }
        @Override public Single<Boolean> finalizationPending(com.agui.adk.hitl.ResumeClaim claim) {
            if (failNextFinalizationPendingRead) {
                failNextFinalizationPendingRead = false;
                return Single.error(new IllegalStateException("finalization state unavailable"));
            }
            return delegate.finalizationPending(claim);
        }
        @Override public Completable releaseFinalization(com.agui.adk.hitl.ResumeClaim claim) {
            if (throwNextReleaseFinalization) {
                throwNextReleaseFinalization = false;
                throw new IllegalStateException("release factory failed");
            }
            return delegate.releaseFinalization(claim);
        }
        @Override public Completable complete(com.agui.adk.hitl.ResumeClaim claim) {
            return Completable.fromAction(() -> {
                completions++;
                trace.add("complete");
                if (failNextComplete) {
                    failNextComplete = false;
                    throw new IllegalStateException("complete failed");
                }
            }).andThen(delegate.complete(claim));
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final CountDownLatch terminal = new CountDownLatch(1);
        private final List<Event> events = new ArrayList<>();
        private Flow.Subscription subscription;
        private Throwable error;
        @Override public void onSubscribe(Flow.Subscription value) { subscription = value; value.request(Long.MAX_VALUE); }
        @Override public void onNext(Event event) { events.add(event); }
        @Override public void onError(Throwable failure) { error = failure; terminal.countDown(); }
        @Override public void onComplete() { terminal.countDown(); }
        void cancel() { subscription.cancel(); }
        boolean await() throws InterruptedException { return terminal.await(1, TimeUnit.SECONDS); }
        boolean terminal() { return terminal.getCount() == 0; }
    }
}
