package com.agui.adk;

import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.observers.TestObserver;
import com.agui.community.core.message.UserMessage;
import io.reactivex.rxjava3.subjects.SingleSubject;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.argThat;
import static org.mockito.Mockito.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionManagerBaselineTest {

    @Mock
    private BaseSessionService sessionService;
    @Mock
    private BaseMemoryService memoryService;
    @Mock
    private RunContext runContext;

    private SessionManager sessionManager;

    @BeforeEach
    void setUp() {
        sessionManager = new SessionManager(sessionService, memoryService);
    }

    @Test
    void shouldGetSessionAndProcessedIds_whenSessionExists() {
        when(runContext.appName()).thenReturn("test-app");
        when(runContext.userId()).thenReturn("test-user");
        when(runContext.sessionId()).thenReturn("session-1");
        Session session = session("session-1", new ConcurrentHashMap<>());
        when(sessionService.getSession(any(), any(), any(), any()))
                .thenReturn(Maybe.just(session));

        TestObserver<SessionManager.SessionWithProcessedIds> observer = new TestObserver<>();
        sessionManager.getSessionAndProcessedMessageIds(runContext).subscribe(observer);

        observer.assertComplete();
        observer.assertNoErrors();
        observer.assertValueCount(1);
        observer.assertValue(data -> data.session().equals(session) && data.processedIds().isEmpty());
        verify(sessionService, times(1)).getSession(any(), any(), any(), any());
        verify(sessionService, never()).createSession(any(), any(), any(), any());
    }

    @Test
    void shouldDeleteAllUserSessions_whenRequested() {
        Session session1 = session("session-1", Map.of());
        Session session2 = session("session-2", Map.of());
        ListSessionsResponse response = ListSessionsResponse.builder()
                .sessions(List.of(session1, session2))
                .build();
        when(sessionService.listSessions(any(), any())).thenReturn(Single.just(response));
        when(memoryService.addSessionToMemory(any(Session.class))).thenReturn(Completable.complete());
        when(sessionService.deleteSession(any(), any(), any())).thenReturn(Completable.complete());
        when(sessionService.getSession(any(), any(), any(), any()))
                .thenReturn(Maybe.just(session1), Maybe.just(session2));

        TestObserver<Void> observer = new TestObserver<>();
        sessionManager.deleteAllUserAppNameSessions("test-app", "test-user").subscribe(observer);

        observer.assertComplete();
        observer.assertNoErrors();
        verify(sessionService, times(1)).listSessions("test-app", "test-user");
        verify(sessionService, times(2)).deleteSession(any(), any(), any());
        verify(memoryService, times(2)).addSessionToMemory(any());
    }

    @Test
    void shouldAppendMessageIdsToState_whenMarkingAsProcessed() throws InterruptedException {
        Session session = session("session-1", new ConcurrentHashMap<>());
        when(sessionService.appendEvent(any(), any()))
                .thenReturn(Single.just(Event.builder().build()));
        List<String> messageIds = List.of("msg-1", "msg-2");

        TestObserver<Void> observer = new TestObserver<>();
        sessionManager.markMessagesProcessed(session, messageIds).subscribe(observer);

        observer.await(5, TimeUnit.SECONDS);
        observer.assertComplete();
        observer.assertNoErrors();
        verify(sessionService, times(1)).appendEvent(eq(session), argThat(event -> {
            Map<String, Object> stateDelta = event.actions().stateDelta();
            return stateDelta != null && stateDelta.containsKey("processedMessageIds");
        }));
    }

    @Test
    void cumulativeProcessedIdDeltaSurvivesStaleSessionSnapshotAcrossSuccessiveAppends() {
        Session session = session("session-1", new ConcurrentHashMap<>());
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));

        sessionManager.markMessagesProcessed(session, List.of("first")).blockingAwait();
        sessionManager.markMessagesProcessed(session, List.of("second")).blockingAwait();

        ArgumentCaptor<Event> events = ArgumentCaptor.forClass(Event.class);
        verify(sessionService, times(2)).appendEvent(eq(session), events.capture());
        assertThat(events.getAllValues().get(1).actions().stateDelta().get("processedMessageIds"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.SET)
                .containsExactlyInAnyOrder("first", "second");
    }

    @Test
    void isolatesCachedProcessedStateForSessionsWithSameIdAcrossAppAndUser() {
        Session firstPrincipal = Session.builder("shared-session")
                .appName("app-one")
                .userId("user-one")
                .state(new ConcurrentHashMap<>(Map.of("processedMessageIds", Set.of("first"))))
                .build();
        Session secondPrincipal = Session.builder("shared-session")
                .appName("app-two")
                .userId("user-two")
                .state(new ConcurrentHashMap<>())
                .build();
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));

        sessionManager.markMessagesProcessed(firstPrincipal, List.of("first-new")).blockingAwait();
        sessionManager.markMessagesProcessed(secondPrincipal, List.of("second-new")).blockingAwait();

        verify(sessionService).appendEvent(eq(secondPrincipal), argThat(event ->
                event.actions().stateDelta().get("processedMessageIds") instanceof Set<?> ids
                        && ids.size() == 1 && ids.contains("second-new")));
    }

    @Test
    void doesNotSerializeDistinctPrincipalsThatShareASessionId() {
        Session firstPrincipal = Session.builder("shared-session")
                .appName("app-one")
                .userId("user-one")
                .state(new ConcurrentHashMap<>())
                .build();
        Session secondPrincipal = Session.builder("shared-session")
                .appName("app-two")
                .userId("user-two")
                .state(new ConcurrentHashMap<>())
                .build();
        SingleSubject<Event> firstAppend = SingleSubject.create();
        when(sessionService.appendEvent(eq(firstPrincipal), any())).thenReturn(firstAppend);
        when(sessionService.appendEvent(eq(secondPrincipal), any()))
                .thenReturn(Single.just(Event.builder().build()));
        TestObserver<Void> first = sessionManager.markMessagesProcessed(firstPrincipal, List.of("first")).test();
        TestObserver<Void> second = sessionManager.markMessagesProcessed(secondPrincipal, List.of("second")).test();

        second.awaitDone(1, TimeUnit.SECONDS).assertComplete().assertNoErrors();
        firstAppend.onSuccess(Event.builder().build());
        first.awaitDone(1, TimeUnit.SECONDS).assertComplete().assertNoErrors();
    }

    @Test
    void publishesProcessedMessageCacheOnlyAfterDurableAppendSucceeds() {
        Session immutableSnapshot = Session.builder("session-1")
                .appName("test-app")
                .userId("test-user")
                .state(Map.of("processedMessageIds", List.of("durable-before"),
                        "_ag_ui_message_fingerprints", Map.of("durable-before", "before-fingerprint")))
                .build();
        ControllableSessionService controllableSessionService =
                new ControllableSessionService(immutableSnapshot);
        SessionManager realSessionManager = new SessionManager(controllableSessionService, memoryService);
        UserMessage messageA = new UserMessage("message-a", "A");
        UserMessage messageB = new UserMessage("message-b", "B");

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> realSessionManager
                        .markMessagesProcessedWithFingerprints(immutableSnapshot, List.of(messageA))
                        .blockingAwait())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("append A failed");

        realSessionManager.markMessagesProcessedWithFingerprints(immutableSnapshot, List.of(messageB)).blockingAwait();
        assertThat(controllableSessionService.durableDeltas().get(1).get("processedMessageIds"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.SET)
                .containsExactlyInAnyOrder("durable-before", "message-b");
        assertThat(controllableSessionService.durableDeltas().get(1).get("_ag_ui_message_fingerprints"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("durable-before", "before-fingerprint")
                .containsEntry("message-b", com.agui.adk.message.MessageFingerprint.of(messageB))
                .doesNotContainKey("message-a");

        realSessionManager.markMessagesProcessedWithFingerprints(immutableSnapshot, List.of(messageA)).blockingAwait();
        assertThat(controllableSessionService.durableDeltas().get(2).get("processedMessageIds"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.SET)
                .containsExactlyInAnyOrder("durable-before", "message-b", "message-a");
        assertThat(controllableSessionService.durableDeltas().get(2).get("_ag_ui_message_fingerprints"))
                .asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("durable-before", "before-fingerprint")
                .containsEntry("message-b", com.agui.adk.message.MessageFingerprint.of(messageB))
                .containsEntry("message-a", com.agui.adk.message.MessageFingerprint.of(messageA));
    }

    @Test
    void cumulativeProcessedIdDeltaPreservesExistingCollectionEncodings() {
        List<Object> encodings = List.of(
                List.of("old"),
                new String[]{"old"},
                "[\"old\"]");
        for (Object encoding : encodings) {
            Session session = session("session-" + encodings.indexOf(encoding),
                    new ConcurrentHashMap<>(Map.of("processedMessageIds", encoding)));
            when(sessionService.appendEvent(eq(session), any())).thenReturn(Single.just(Event.builder().build()));

            sessionManager.markMessagesProcessed(session, List.of("new")).blockingAwait();

            verify(sessionService).appendEvent(eq(session), argThat(event -> {
                Object ids = event.actions().stateDelta().get("processedMessageIds");
                return ids instanceof java.util.Set<?> values && values.containsAll(List.of("old", "new"));
            }));
        }
    }

    private static final class ControllableSessionService implements BaseSessionService {
        private final Session snapshot;
        private final List<Map<String, Object>> durableDeltas = new java.util.ArrayList<>();
        private int appendAttempts;

        private ControllableSessionService(Session snapshot) {
            this.snapshot = snapshot;
        }

        @Override
        public Single<Session> createSession(
                String appName,
                String userId,
                java.util.concurrent.ConcurrentMap<String, Object> state,
                String sessionId) {
            return Single.just(snapshot);
        }

        @Override
        public Maybe<Session> getSession(
                String appName,
                String userId,
                String sessionId,
                java.util.Optional<com.google.adk.sessions.GetSessionConfig> config) {
            return Maybe.just(snapshot);
        }

        @Override
        public Single<ListSessionsResponse> listSessions(String appName, String userId) {
            return Single.error(new UnsupportedOperationException());
        }

        @Override
        public Completable deleteSession(String sessionId, String appName, String userId) {
            return Completable.complete();
        }

        @Override
        public Single<com.google.adk.sessions.ListEventsResponse> listEvents(
                String appName, String userId, String sessionId) {
            return Single.error(new UnsupportedOperationException());
        }

        @Override
        public Single<Event> appendEvent(Session session, Event event) {
            durableDeltas.add(event.actions().stateDelta());
            return appendAttempts++ == 0
                    ? Single.error(new IllegalStateException("append A failed"))
                    : Single.just(Event.builder().build());
        }

        private List<Map<String, Object>> durableDeltas() {
            return durableDeltas;
        }
    }

    @Test
    void pendingToolResultWhoseCallIdHasNoResolvedNameUsesExplicitUnknownName() {
        Session session = session("session-1", new java.util.concurrent.ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", Set.of("call-1"))));
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));

        var results = sessionManager.processToolResults(
                session,
                List.of(new com.agui.community.core.message.ToolMessage("results", "{\"v\":1}", "call-1", null)),
                Map.of()).toList().blockingGet();

        assertThat(results).singleElement().satisfies(result ->
                assertThat(result.toolName()).isEqualTo("unknown"));
    }

    @Test
    void pendingToolResultWithMissingCallIdFailsExplicitly() {
        Session session = session("session-1", new java.util.concurrent.ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", Set.of("call-1"))));

        assertThatThrownBy(() -> sessionManager.processToolResults(
                session,
                List.of(new com.agui.community.core.message.ToolMessage("results", "{}", "", null)),
                Map.of("call-1", "browser")).toList().blockingGet())
                .hasMessageContaining("requires a non-blank tool-call ID");
    }

    @Test
    void duplicateToolCallNameLookupUsesTheLastValue() {
        Session session = session("session-1", new java.util.concurrent.ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", Set.of("call-1"))));
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        Map<String, String> names = new java.util.LinkedHashMap<>();
        names.put("call-1", "first");
        names.put("call-1", "last");

        var results = sessionManager.processToolResults(
                session,
                List.of(new com.agui.community.core.message.ToolMessage("results", "{}", "call-1", null)),
                names).toList().blockingGet();

        assertThat(results).singleElement().satisfies(result ->
                assertThat(result.toolName()).isEqualTo("last"));
    }

    @Test
    void pendingToolResultSkipsSyntheticConfirmChangesResultButKeepsNamedSibling() {
        Session session = session("session-1", new java.util.concurrent.ConcurrentHashMap<>(Map.of(
                "pendingToolCallIds", Set.of("call-1", "confirm-id"))));
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));

        var results = sessionManager.processToolResults(
                session,
                List.of(
                        new com.agui.community.core.message.ToolMessage("results", "{\"v\":1}", "call-1", null),
                        new com.agui.community.core.message.ToolMessage("results", "{}", "confirm-id", null)),
                Map.of("call-1", "browser", "confirm-id", "confirm_changes")).toList().blockingGet();

        assertThat(results).singleElement().satisfies(result ->
                assertThat(result.toolName()).isEqualTo("browser"));
    }

    private static Session session(String id, Map<String, Object> state) {
        return Session.builder(id)
                .appName("test-app")
                .userId("test-user")
                .state(state)
                .build();
    }
}
