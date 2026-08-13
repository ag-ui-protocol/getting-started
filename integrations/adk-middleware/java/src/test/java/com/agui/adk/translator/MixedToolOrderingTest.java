package com.agui.adk.translator;

import com.google.adk.agents.RunConfig;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.agui.adk.AdkRunnerClient;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.SessionManager;
import com.agui.adk.SessionManagerTestFixtures;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.encoding.PreEncodedEvent;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingCallStore;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subjects.CompletableSubject;
import io.reactivex.rxjava3.processors.PublishProcessor;
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

class MixedToolOrderingTest {

    @Test
    void realAgentPersistsFrontendCallBeforeVisibilityAndEmitsOnlyOneOfficialChunk() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        RecordingStore store = new RecordingStore();
        CompletableSubject persisted = CompletableSubject.create();
        store.nextPersistence = persisted;
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(frontendCall("browser-1", "pick")));

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(store.awaitPersistenceStart()).isTrue();
        assertThat(store.calls).hasSize(1);
        assertThat(subscriber.events).noneMatch(ToolCallChunkEvent.class::isInstance);
        persisted.onComplete();
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).filteredOn(ToolCallChunkEvent.class::isInstance)
                .singleElement().isInstanceOfSatisfying(ToolCallChunkEvent.class, chunk -> {
                    assertThat(chunk.toolCallId()).isEqualTo("browser-1");
                    assertThat(chunk.rawEvent()).isInstanceOfSatisfying(PreEncodedEvent.class,
                            encoded -> assertThat(encoded.json()).isEqualTo("{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"browser-1\",\"toolCallName\":\"pick\",\"delta\":\"{}\"}"));
                });
        assertThat(subscriber.events).noneMatch(event -> event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent || event instanceof ToolCallEndEvent);
    }

    @Test
    void realAgentSettlesIdenticalExplicitProviderIdFrontendCallsOnce() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(duplicateFrontendCalls(
                "duplicate", Map.of("choice", "one"), Map.of("choice", "one"))));

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).filteredOn(ToolCallChunkEvent.class::isInstance)
                .singleElement().isInstanceOfSatisfying(ToolCallChunkEvent.class,
                        chunk -> assertThat(chunk.toolCallId()).isEqualTo("duplicate"));
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).filteredOn(ToolCallChunkEvent.class::isInstance)
                .singleElement().isInstanceOfSatisfying(ToolCallChunkEvent.class,
                        chunk -> assertThat(chunk.toolCallId()).isEqualTo("duplicate"));
        assertThat(subscriber.events).noneMatch(event -> event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent || event instanceof ToolCallEndEvent);
    }

    @Test
    void realAgentRejectsConflictingExplicitProviderIdFrontendCallsBeforeVisibility() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(duplicateFrontendCalls(
                "duplicate", Map.of("choice", "one"), Map.of("choice", "two"))));

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).startsWith(new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertThat(run.events).noneMatch(event -> event instanceof ToolCallChunkEvent
                || event instanceof ToolCallStartEvent || event instanceof ToolCallArgsEvent
                || event instanceof ToolCallEndEvent);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentRejectsConflictingPartialExplicitProviderIdsBeforeVisibilityOrReplay() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(partialDuplicateFrontendCalls(
                "duplicate", Map.of("choice", "one"), Map.of("choice", "two"))));

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).startsWith(new RunStartedEvent("thread", "run"),
                new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertNoToolEvents(run.events);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentSettlesIdenticalPartialExplicitProviderIdsOnce() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(partialDuplicateFrontendCalls(
                "duplicate", Map.of("choice", "one"), Map.of("choice", "one"))));

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).filteredOn(ToolCallChunkEvent.class::isInstance).singleElement()
                .isInstanceOfSatisfying(ToolCallChunkEvent.class, chunk -> assertThat(chunk.toolCallId()).isEqualTo("duplicate"));
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).filteredOn(ToolCallChunkEvent.class::isInstance).singleElement();
    }

    @Test
    void realAgentSuppressesPartialBackendResultWhenRetainedFrontendEncodingFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.fromArray(
                partialMixedFrontendAndBackendCalls(), backendResponse("backend-b", "weather")), event -> {
            throw new IllegalArgumentException("cannot encode frontend A");
        });

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).startsWith(new RunStartedEvent("thread", "run"), new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertNoToolEvents(run.events);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentPreflightsRetainedMixedBatchBeforePartialBackendResultOnFrontendPersistenceFailure()
            throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        GatedFailingPersistStore store = new GatedFailingPersistStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.fromArray(
                partialMixedFrontendAndBackendCalls(), backendResponse("backend-b", "weather")));

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertThat(store.awaitPersistenceStart()).isTrue();
        boolean toolVisibleBeforeFailure = run.events.stream().anyMatch(MixedToolOrderingTest::isToolEvent);
        store.failPersistence();
        assertThat(run.await()).isTrue();
        assertThat(toolVisibleBeforeFailure).isFalse();
        assertThat(run.events).startsWith(
                new RunStartedEvent("thread", "run"), new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertNoToolEvents(run.events);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentWaitsForRicherFrontendFinalBeforeExposingRetainedBackendResult() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        PublishProcessor<com.google.adk.events.Event> finalView = PublishProcessor.create();
        GoogleAdkAgent agent = agent(sessions, store, Flowable.concatArray(
                Flowable.just(partialMixedFrontendAndBackendCalls(), backendResponse("backend-b", "weather")), finalView));

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertNoToolEvents(run.events);
        finalView.onNext(finalFrontendCallWithRicherArgs());
        finalView.onComplete();
        assertThat(run.await()).isTrue();
        assertThat(run.events).extracting(event -> event instanceof ToolCallChunkEvent chunk
                        ? chunk.toolCallId() + ":" + ((PreEncodedEvent) chunk.rawEvent()).json()
                        : event instanceof ToolCallStartEvent start ? "start:" + start.toolCallId()
                        : event instanceof ToolCallArgsEvent args ? "args:" + args.delta()
                        : event instanceof ToolCallEndEvent end ? "end:" + end.toolCallId()
                        : event instanceof ToolCallResultEvent result ? "result:" + result.toolCallId()
                        : event)
                .containsSubsequence(new RunStartedEvent("thread", "run"),
                        "frontend-a:{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"frontend-a\",\"toolCallName\":\"pick\",\"delta\":\"{\\\"choice\\\":\\\"rich\\\"}\"}",
                        "start:backend-b", "end:backend-b", "result:backend-b");
        assertThat(run.events).filteredOn(ToolCallChunkEvent.class::isInstance).hasSize(1);
        assertThat(run.events).filteredOn(ToolCallResultEvent.class::isInstance).hasSize(1);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).filteredOn(ToolCallChunkEvent.class::isInstance).singleElement()
                .isInstanceOfSatisfying(ToolCallChunkEvent.class, chunk -> assertThat(((PreEncodedEvent) chunk.rawEvent()).json())
                        .contains("\\\"choice\\\":\\\"rich\\\""));
    }

    @Test
    void realAgentKeepsFirstDeferredBackendResultWhileWaitingForRicherFrontendFinal() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.fromArray(
                partialMixedFrontendAndBackendCalls(), backendResponse("backend-b", "weather", 1),
                backendResponse("backend-b", "weather", 2), finalFrontendCallWithRicherArgs()));

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).filteredOn(ToolCallResultEvent.class::isInstance).singleElement()
                .isInstanceOfSatisfying(ToolCallResultEvent.class, result -> {
                    assertThat(result.toolCallId()).isEqualTo("backend-b");
                    assertThat(result.content()).isEqualTo("{\"seq\":1}");
                });
        assertThat(run.events).filteredOn(event -> event instanceof ToolCallStartEvent start
                        && start.toolCallId().equals("backend-b"))
                .singleElement();
        assertThat(run.events).filteredOn(event -> event instanceof ToolCallArgsEvent args
                        && args.toolCallId().equals("backend-b"))
                .isEmpty();
        assertThat(run.events).filteredOn(event -> event instanceof ToolCallEndEvent end
                        && end.toolCallId().equals("backend-b"))
                .singleElement();
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).filteredOn(ToolCallChunkEvent.class::isInstance).singleElement()
                .isInstanceOfSatisfying(ToolCallChunkEvent.class, chunk -> assertThat(((PreEncodedEvent) chunk.rawEvent()).json())
                        .contains("\\\"choice\\\":\\\"rich\\\""));
    }

    @Test
    void realAgentSuppressesDelayedBatchWhenRicherFrontendFinalEncodingFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        PublishProcessor<com.google.adk.events.Event> finalView = PublishProcessor.create();
        GoogleAdkAgent agent = agent(sessions, store, Flowable.concatArray(
                Flowable.just(partialMixedFrontendAndBackendCalls(), backendResponse("backend-b", "weather")), finalView),
                event -> { throw new IllegalArgumentException("cannot encode richer frontend A"); });

        RecordingSubscriber run = subscribe(agent.run(input()));

        assertNoToolEvents(run.events);
        finalView.onNext(finalFrontendCallWithRicherArgs());
        finalView.onComplete();
        assertThat(run.await()).isTrue();
        assertThat(run.events).startsWith(new RunStartedEvent("thread", "run"), new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertNoToolEvents(run.events);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentWithholdsEarlierBackendLifecycleWhenLaterFrontendEncodingFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, new RecordingStore(),
                Flowable.just(mixedCalls("weather", "pick")), event -> {
                    throw new IllegalArgumentException("cannot encode");
                });

        RecordingSubscriber subscriber = subscribe(agent.run(input()));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"), new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
    }

    @Test
    void realAgentRemovesEarlierFrontendCallWhenLaterSiblingEncodingFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(partialFrontendSiblings("frontend-a", "frontend-b")), event -> {
            if (event.toolCallId().equals("frontend-b")) {
                throw new IllegalArgumentException("cannot encode B");
            }
            return new EncodedEvent(event, "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\""
                    + event.toolCallId() + "\",\"toolCallName\":\"" + event.toolCallName()
                    + "\",\"delta\":\"{}\"}");
        });

        RecordingSubscriber run = subscribe(agent.run(siblingInput()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).startsWith(new RunStartedEvent("thread", "run"), new RunErrorEvent("Event encoding failed", "ENCODING_ERROR", null, null));
        assertThat(run.events).noneMatch(ToolCallChunkEvent.class::isInstance);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentRemovesEarlierFrontendCallWhenLaterSiblingPersistenceFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FailingSecondPersistStore store = new FailingSecondPersistStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store,
                Flowable.just(partialFrontendSiblings("frontend-a", "frontend-b")));

        RecordingSubscriber run = subscribe(agent.run(siblingInput()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).startsWith(
                new RunStartedEvent("thread", "run"), new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        assertThat(run.events).noneMatch(ToolCallChunkEvent.class::isInstance);
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).isEmpty();
    }

    @Test
    void realAgentRetainsEarlierPartialProviderEventWhenLaterEventPersistenceFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FailingSecondPersistStore store = new FailingSecondPersistStore();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.fromArray(
                partialFrontendCall("frontend-a", "pick-a"), partialFrontendCall("frontend-b", "pick-b")));

        RecordingSubscriber run = subscribe(agent.run(siblingInput()));

        assertThat(run.await()).isTrue();
        assertThat(run.events).extracting(event -> event instanceof ToolCallChunkEvent chunk
                        ? chunk.toolCallId() : event)
                .startsWith(new RunStartedEvent("thread", "run"), "frontend-a",
                        new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));
        assertThat(replay.await()).isTrue();
        assertThat(replay.events).filteredOn(ToolCallChunkEvent.class::isInstance)
                .extracting(event -> ((ToolCallChunkEvent) event).toolCallId())
                .containsExactly("frontend-a");
        assertThat(replay.events).anySatisfy(event -> {
            assertThat(event).isInstanceOf(com.agui.community.core.event.RunFinishedEvent.class);
            assertThat(((com.agui.community.core.event.RunFinishedEvent) event).outcome())
                    .isInstanceOf(com.agui.community.core.interrupt.InterruptOutcome.class);
        });
    }

    @Test
    void realAgentWithholdsEarlierBackendLifecycleWhenLaterFrontendPersistenceFails() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        RecordingStore store = new RecordingStore();
        CompletableSubject persistence = CompletableSubject.create();
        store.nextPersistence = persistence;
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession()));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        GoogleAdkAgent agent = agent(sessions, store, Flowable.just(mixedCalls("weather", "pick")));

        RecordingSubscriber subscriber = subscribe(agent.run(input()));
        assertThat(store.awaitPersistenceStart()).isTrue();
        assertThat(subscriber.events).startsWith(new RunStartedEvent("thread", "run"));
        persistence.onError(new IllegalStateException("store unavailable"));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.events).startsWith(
                new RunStartedEvent("thread", "run"), new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions, PendingCallStore store, Flowable<com.google.adk.events.Event> events) {
        return agent(sessions, store, events, event -> new EncodedEvent(event,
                "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"" + event.toolCallId()
                        + "\",\"toolCallName\":\"" + event.toolCallName()
                        + "\",\"delta\":\"" + event.delta().replace("\"", "\\\"") + "\"}"));
    }

    private static GoogleAdkAgent agent(
            SessionManager sessions,
            PendingCallStore store,
            Flowable<com.google.adk.events.Event> events,
            com.agui.adk.encoding.CanonicalEventEncoder encoder) {
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        return GoogleAdkAgent.builder().runner(new AdkRunnerClient() {
                    @Override
                    public String appName() {
                        return "app";
                    }

                    @Override
                    public Flowable<com.google.adk.events.Event> runAsync(
                            String userId, String sessionId, Content content, RunConfig runConfig,
                            Map<String, Object> stateDelta) {
                        return events;
                    }
                }).sessionManager(sessions).configuredBackendToolNames(Set.of()).userIdExtractor(ignored -> "user")
                .pendingCallStore(store).eventEncoder(encoder).build();
    }

    private static RunAgentInput input() {
        return new RunAgentInput("thread", "run", Map.of(), List.of(new UserMessage("message", "Hi")),
                List.of(new Tool("pick", "Select an item", new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("rawToolSchemas", List.of(Map.of(
                        "position", 0, "name", "pick", "schema", Map.of("type", "object"))))));
    }

    private static com.google.adk.events.Event frontendCall(String id, String name) {
        return com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model")
                .parts(Part.builder().functionCall(FunctionCall.builder().id(id).name(name).args(Map.of()).build()).build())
                .build()).build();
    }

    private static com.google.adk.events.Event mixedCalls(String backendName, String frontendName) {
        return com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model").parts(
                Part.builder().functionCall(FunctionCall.builder().id("backend").name(backendName).args(Map.of()).build()).build(),
                Part.builder().functionCall(FunctionCall.builder().id("frontend").name(frontendName).args(Map.of()).build()).build())
                .build()).build();
    }

    private static com.google.adk.events.Event partialMixedFrontendAndBackendCalls() {
        return com.google.adk.events.Event.builder().author("model").partial(true)
                .content(Content.builder().role("model").parts(
                        Part.builder().functionCall(FunctionCall.builder().id("frontend-a").name("pick").args(Map.of()).build()).build(),
                        Part.builder().functionCall(FunctionCall.builder().id("backend-b").name("weather").args(Map.of()).build()).build())
                        .build()).build();
    }

    private static com.google.adk.events.Event finalFrontendCallWithRicherArgs() {
        return com.google.adk.events.Event.builder().author("model").content(Content.builder().role("model")
                .parts(Part.builder().functionCall(FunctionCall.builder().id("frontend-a").name("pick")
                        .args(Map.of("choice", "rich")).build()).build()).build()).build();
    }

    private static com.google.adk.events.Event backendResponse(String id, String name) {
        return backendResponse(id, name, Map.of("ok", true));
    }

    private static com.google.adk.events.Event backendResponse(String id, String name, int sequence) {
        return backendResponse(id, name, Map.of("seq", sequence));
    }

    private static com.google.adk.events.Event backendResponse(String id, String name, Map<String, Object> response) {
        return com.google.adk.events.Event.builder().author("tool").content(Content.builder().role("tool")
                .parts(Part.builder().functionResponse(com.google.genai.types.FunctionResponse.builder()
                        .id(id).name(name).response(response).build()).build()).build()).build();
    }

    private static boolean isToolEvent(Event event) {
        return event instanceof ToolCallChunkEvent || event instanceof ToolCallStartEvent
                || event instanceof ToolCallArgsEvent || event instanceof ToolCallEndEvent
                || event instanceof ToolCallResultEvent;
    }

    private static void assertNoToolEvents(List<Event> events) {
        assertThat(events).noneMatch(MixedToolOrderingTest::isToolEvent);
    }

    private static com.google.adk.events.Event duplicateFrontendCalls(
            String id, Map<String, Object> firstArgs, Map<String, Object> secondArgs) {
        return duplicateFrontendCalls(id, firstArgs, secondArgs, false);
    }

    private static com.google.adk.events.Event partialDuplicateFrontendCalls(
            String id, Map<String, Object> firstArgs, Map<String, Object> secondArgs) {
        return duplicateFrontendCalls(id, firstArgs, secondArgs, true);
    }

    private static com.google.adk.events.Event duplicateFrontendCalls(
            String id, Map<String, Object> firstArgs, Map<String, Object> secondArgs, boolean partial) {
        return com.google.adk.events.Event.builder().author("model").partial(partial)
                .content(Content.builder().role("model").parts(
                        Part.builder().functionCall(FunctionCall.builder().id(id).name("pick").args(firstArgs).build()).build(),
                        Part.builder().functionCall(FunctionCall.builder().id(id).name("pick").args(secondArgs).build()).build())
                        .build()).build();
    }

    private static com.google.adk.events.Event frontendSiblings(String firstId, String secondId) {
        return frontendSiblings(firstId, secondId, false);
    }

    private static com.google.adk.events.Event partialFrontendSiblings(String firstId, String secondId) {
        return frontendSiblings(firstId, secondId, true);
    }

    private static com.google.adk.events.Event partialFrontendCall(String id, String name) {
        return com.google.adk.events.Event.builder().author("model").partial(true).content(Content.builder().role("model")
                .parts(Part.builder().functionCall(FunctionCall.builder().id(id).name(name).args(Map.of()).build()).build())
                .build()).build();
    }

    private static com.google.adk.events.Event frontendSiblings(String firstId, String secondId, boolean partial) {
        return com.google.adk.events.Event.builder().author("model").partial(partial).content(Content.builder().role("model").parts(
                Part.builder().functionCall(FunctionCall.builder().id(firstId).name("pick-a").args(Map.of()).build()).build(),
                Part.builder().functionCall(FunctionCall.builder().id(secondId).name("pick-b").args(Map.of()).build()).build())
                .build()).build();
    }

    private static RunAgentInput siblingInput() {
        return new RunAgentInput("thread", "run", Map.of(), List.of(new UserMessage("message", "Hi")),
                List.of(new Tool("pick-a", "Select A", new ToolParameters(Map.of(), List.of())),
                        new Tool("pick-b", "Select B", new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY,
                        Map.of("rawToolSchemas", List.of(
                                Map.of("position", 0, "name", "pick-a", "schema", Map.of("type", "object")),
                                Map.of("position", 1, "name", "pick-b", "schema", Map.of("type", "object"))))));
    }

    private static ResolvedSession resolvedSession() {
        Session session = Session.builder("session").appName("app").userId("user").state(Map.of()).build();
        return new ResolvedSession(session, new SessionMapping(new SessionMappingKey("app", "user", "thread"), "session"));
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class RecordingStore implements PendingCallStore {
        private final List<PendingToolCall> calls = new ArrayList<>();
        private final CountDownLatch persistenceStarted = new CountDownLatch(1);
        private Completable nextPersistence = Completable.complete();

        @Override
        public Completable persist(PendingToolCall call) {
            calls.add(call);
            persistenceStarted.countDown();
            return nextPersistence;
        }

        private boolean awaitPersistenceStart() throws InterruptedException {
            return persistenceStarted.await(1, TimeUnit.SECONDS);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return Flowable.fromIterable(calls);
        }
    }

    private static final class GatedFailingPersistStore implements PendingCallStore {
        private final CompletableSubject persistence = CompletableSubject.create();
        private final CountDownLatch persistenceStarted = new CountDownLatch(1);

        @Override
        public Completable persist(PendingToolCall call) {
            persistenceStarted.countDown();
            return persistence;
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return Flowable.empty();
        }

        private boolean awaitPersistenceStart() throws InterruptedException {
            return persistenceStarted.await(1, TimeUnit.SECONDS);
        }

        private void failPersistence() {
            persistence.onError(new IllegalStateException("cannot persist frontend A"));
        }
    }

    private static final class FailingSecondPersistStore implements PendingCallStore {
        private final SessionPendingCallStore delegate = new SessionPendingCallStore();
        private int persistCount;

        @Override
        public Completable persist(PendingToolCall call) {
            persistCount++;
            return persistCount == 2
                    ? Completable.error(new IllegalStateException("cannot persist B"))
                    : delegate.persist(call);
        }

        @Override
        public Completable remove(com.agui.adk.hitl.PendingCallGroupKey group, Set<String> toolCallIds) {
            return delegate.remove(group, toolCallIds);
        }

        @Override
        public Flowable<PendingToolCall> pending(PendingCallScope scope) {
            return delegate.pending(scope);
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch complete = new CountDownLatch(1);

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            events.add(event);
        }

        @Override
        public void onError(Throwable error) {
            complete.countDown();
        }

        @Override
        public void onComplete() {
            complete.countDown();
        }

        private boolean await() throws InterruptedException {
            return complete.await(1, TimeUnit.SECONDS);
        }
    }
}
