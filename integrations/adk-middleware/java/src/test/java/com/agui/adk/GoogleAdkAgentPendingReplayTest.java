package com.agui.adk;

import com.google.adk.sessions.Session;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.encoding.PreEncodedEvent;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingCallStore;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class GoogleAdkAgentPendingReplayTest {

    @Test
    void publicReplayReturnsRetainedPrevalidatedJsonWithoutReencoding()
            throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store =
                new SessionPendingCallStore();
        PendingCallScope scope =
                new PendingCallScope(
                        "app",
                        "user",
                        "resolved-session");
        ToolCallChunkEvent event =
                new ToolCallChunkEvent(
                        "provider:call",
                        "frontend",
                        "{\"x\":1}");
        String json =
                "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"provider:call\","
                        + "\"toolCallName\":\"frontend\",\"delta\":\"{\\\"x\\\":1}\"}";
        store.persist(
                        new PendingToolCall(
                                new PendingCallKey(
                                        new PendingCallGroupKey(
                                                scope,
                                                "invocation"),
                                        event.toolCallId()),
                                event,
                                json,
                                PendingStatus.PENDING))
                .blockingAwait();
        when(sessions.findExistingSession(
                        "app",
                        "user",
                        "thread"))
                .thenReturn(
                        io.reactivex.rxjava3.core.Maybe.just(
                                resolvedSession()));
        AtomicInteger encoderCalls =
                new AtomicInteger();
        GoogleAdkAgent agent =
                GoogleAdkAgent.builder()
                        .runner(mock(AdkRunnerClient.class))
                        .sessionManager(sessions)
                        .configuredBackendToolNames(Set.of())
                        .userIdExtractor(input -> "unused")
                        .pendingCallStore(store)
                        .eventEncoder(encoded -> {
                            encoderCalls.incrementAndGet();
                            return new EncodedEvent(
                                    encoded,
                                    "must-not-be-used");
                        })
                        .build();

        List<Event> replay =
                collect(
                        agent.replayPendingCalls(
                                "app",
                                "user",
                                "thread",
                                Set.of()));

        assertThat(encoderCalls).hasValue(0);
        assertThat(replay)
                .singleElement()
                .isInstanceOfSatisfying(
                        ToolCallChunkEvent.class,
                        replayed ->
                                assertThat(
                                                replayed.rawEvent())
                                        .isEqualTo(
                                                new PreEncodedEvent(
                                                        event,
                                                        json)));
        verify(sessions)
                .findExistingSession(
                        "app",
                        "user",
                        "thread");
    }

    @Test
    void suppressesKnownConfiguredPendingCallIds() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "resolved-session");
        ToolCallChunkEvent event = new ToolCallChunkEvent("provider:call", "frontend", "{}");
        store.persist(new PendingToolCall(
                new PendingCallKey(new PendingCallGroupKey(scope, "invocation"), event.toolCallId()),
                event,
                "json",
                PendingStatus.PENDING)).blockingAwait();
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.just(resolvedSession()));

        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(mock(AdkRunnerClient.class))
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> "unused")
                .pendingCallStore(store)
                .eventEncoder(ignored -> new EncodedEvent(ignored, "unused"))
                .build();

        assertThat(collect(agent.replayPendingCalls("app", "user", "thread", Set.of("provider:call"))))
                .isEmpty();
    }


    @Test
    void publicReplaySynchronousLookupFailureCompletesWithStructuredPersistenceError()
            throws InterruptedException {
        SessionManager sessions =
                mock(SessionManager.class);
        when(sessions.findExistingSession(
                        "app",
                        "user",
                        "thread"))
                .thenThrow(
                        new IllegalStateException(
                                "lookup unavailable"));
        GoogleAdkAgent agent =
                GoogleAdkAgent.builder()
                        .runner(mock(AdkRunnerClient.class))
                        .sessionManager(sessions)
                        .configuredBackendToolNames(Set.of())
                        .userIdExtractor(input -> "unused")
                        .pendingCallStore(
                                new SessionPendingCallStore())
                        .eventEncoder(ignored ->
                                new EncodedEvent(
                                        ignored,
                                        "unused"))
                        .build();

        assertThat(
                        collect(
                                agent.replayPendingCalls(
                                        "app",
                                        "user",
                                        "thread",
                                        Set.of())))
                .containsExactly(
                        new RunErrorEvent(
                                "Persistence failure",
                                "PERSISTENCE_FAILURE",
                                null,
                                null));
        verify(sessions)
                .findExistingSession(
                        "app",
                        "user",
                        "thread");
    }

    @Test
    void publicReplayReactiveStoreFailureCompletesWithStructuredPersistenceError()
            throws InterruptedException {
        SessionManager sessions =
                mock(SessionManager.class);
        when(sessions.findExistingSession(
                        "app",
                        "user",
                        "thread"))
                .thenReturn(
                        io.reactivex.rxjava3.core.Maybe.just(
                                resolvedSession()));
        PendingCallStore store =
                new PendingCallStore() {
                    @Override
                    public io.reactivex.rxjava3.core.Completable persist(
                            PendingToolCall call) {
                        return io.reactivex.rxjava3.core.Completable
                                .complete();
                    }

                    @Override
                    public io.reactivex.rxjava3.core.Flowable<PendingToolCall>
                    pending(PendingCallScope scope) {
                        return io.reactivex.rxjava3.core.Flowable.error(
                                new IllegalStateException(
                                        "pending unavailable"));
                    }
                };
        GoogleAdkAgent agent =
                GoogleAdkAgent.builder()
                        .runner(mock(AdkRunnerClient.class))
                        .sessionManager(sessions)
                        .configuredBackendToolNames(Set.of())
                        .userIdExtractor(input -> "unused")
                        .pendingCallStore(store)
                        .eventEncoder(ignored ->
                                new EncodedEvent(
                                        ignored,
                                        "unused"))
                        .build();

        assertThat(
                        collect(
                                agent.replayPendingCalls(
                                        "app",
                                        "user",
                                        "thread",
                                        Set.of())))
                .containsExactly(
                        new RunErrorEvent(
                                "Persistence failure",
                                "PERSISTENCE_FAILURE",
                                null,
                                null));
        verify(sessions)
                .findExistingSession(
                        "app",
                        "user",
                        "thread");
    }

    @Test
    void replayStoreFailureUsesStructuredPersistenceError() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        when(sessions.findExistingSession("app", "user", "thread"))
                .thenReturn(io.reactivex.rxjava3.core.Maybe.error(new IllegalStateException("store unavailable")));
        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(mock(AdkRunnerClient.class))
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> "unused")
                .pendingCallStore(new SessionPendingCallStore())
                .eventEncoder(ignored -> new EncodedEvent(ignored, "unused"))
                .build();

        assertThat(collect(agent.replayPendingCalls("app", "user", "thread", Set.of())))
                .containsExactly(new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    @Test
    void publicReplayMissingSessionCompletesEmptyWithoutAllocatingIdentity()
            throws InterruptedException {
        SessionManager sessions =
                mock(SessionManager.class);
        when(sessions.findExistingSession(
                        "app",
                        "user",
                        "missing"))
                .thenReturn(
                        io.reactivex.rxjava3.core.Maybe.empty());
        AtomicInteger pendingReads =
                new AtomicInteger();
        PendingCallStore store =
                new PendingCallStore() {
                    @Override
                    public io.reactivex.rxjava3.core.Completable persist(
                            PendingToolCall call) {
                        return io.reactivex.rxjava3.core.Completable
                                .complete();
                    }

                    @Override
                    public io.reactivex.rxjava3.core.Flowable<PendingToolCall>
                    pending(PendingCallScope scope) {
                        pendingReads.incrementAndGet();
                        return io.reactivex.rxjava3.core.Flowable.empty();
                    }
                };
        GoogleAdkAgent agent =
                GoogleAdkAgent.builder()
                        .runner(mock(AdkRunnerClient.class))
                        .sessionManager(sessions)
                        .configuredBackendToolNames(Set.of())
                        .userIdExtractor(input -> "unused")
                        .pendingCallStore(store)
                        .eventEncoder(ignored ->
                                new EncodedEvent(
                                        ignored,
                                        "unused"))
                        .build();

        assertThat(
                        collect(
                                agent.replayPendingCalls(
                                        "app",
                                        "user",
                                        "missing",
                                        Set.of())))
                .isEmpty();
        assertThat(pendingReads).hasValue(0);
        verify(sessions)
                .registerMessageReservationStore(any());
        verify(sessions)
                .findExistingSession(
                        "app",
                        "user",
                        "missing");
        verifyNoMoreInteractions(sessions);
    }

    private static List<Event> collect(Flow.Publisher<Event> publisher) throws InterruptedException {
        List<Event> events = new ArrayList<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                subscription.request(Long.MAX_VALUE);
            }

            @Override
            public void onNext(Event event) {
                events.add(event);
            }

            @Override
            public void onError(Throwable failure) {
                error.set(failure);
                completed.countDown();
            }

            @Override
            public void onComplete() {
                completed.countDown();
            }
        });
        assertThat(completed.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(error).hasValue(null);
        return List.copyOf(events);
    }

    private static ResolvedSession resolvedSession() {
        SessionMappingKey key = new SessionMappingKey("app", "user", "thread");
        return new ResolvedSession(
                Session.builder("resolved-session").appName("app").userId("user").state(Map.of()).build(),
                new SessionMapping(key, "resolved-session"));
    }
}
