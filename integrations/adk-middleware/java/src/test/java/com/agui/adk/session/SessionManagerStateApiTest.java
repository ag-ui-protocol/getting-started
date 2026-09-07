package com.agui.adk.session;

import com.google.adk.events.Event;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.SessionManager;
import com.google.adk.sessions.State;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import com.google.adk.sessions.ListSessionsResponse;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.argThat;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.same;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionManagerStateApiTest {

    @Mock private BaseSessionService sessionService;
    @Mock private BaseMemoryService memoryService;

    private SessionManager manager;

    @BeforeEach
    void setUp() {
        manager = new SessionManager(sessionService, memoryService);
    }

    private static Session session(String id, Map<String, Object> state) {
        return Session.builder(id).appName("app").userId("user").state(new ConcurrentHashMap<>(state)).build();
    }

    @Test
    void updateSessionStatePersistsAUserAuthoredStateDelta() {
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        Session session = session("s1", Map.of());

        manager.updateSessionState(session, Map.of("count", 3)).blockingAwait();

        verify(sessionService, times(1)).appendEvent(same(session), argThat(event ->
                "user".equals(event.author()) && event.actions().stateDelta() != null
                        && 3 == (Integer) event.actions().stateDelta().get("count")));
    }

    @Test
    void setStateValuePersistsASingleKey() {
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        Session session = session("s1", Map.of());

        manager.setStateValue(session, "mode", "dark").blockingAwait();

        verify(sessionService, times(1)).appendEvent(same(session), argThat(event ->
                "dark".equals(event.actions().stateDelta().get("mode"))));
    }

    @Test
    void removeStateKeysEmitsRemovalMarkersOnlyForPresentKeys() {
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        Session session = session("s1", Map.of("a", 1));

        manager.removeStateKeys(session, List.of("a", "missing")).blockingAwait();

        verify(sessionService, times(1)).appendEvent(same(session), argThat(event -> {
            Map<String, Object> delta = event.actions().stateDelta();
            return delta.size() == 1 && delta.get("a") == State.REMOVED;
        }));
    }

    @Test
    void clearSessionStatePreservesPrefixedKeys() {
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        Session session = session("s1", Map.of("user:name", "x", "mode", "dark"));

        manager.clearSessionState(session, List.of("user:")).blockingAwait();

        verify(sessionService, times(1)).appendEvent(same(session), argThat(event -> {
            Map<String, Object> delta = event.actions().stateDelta();
            return delta.containsKey("mode") && !delta.containsKey("user:name");
        }));
    }

    @Test
    void initializeSessionStateSkipsExistingKeysUnlessOverwriteRequested() {
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));
        Session session = session("s1", Map.of("existing", 1));

        manager.initializeSessionState(session, Map.of("existing", 99, "fresh", "v"), false).blockingAwait();
        verify(sessionService, times(1)).appendEvent(same(session), argThat(event -> {
            Map<String, Object> delta = event.actions().stateDelta();
            return delta.size() == 1 && "v".equals(delta.get("fresh"));
        }));
    }

    @Test
    void getSessionStateReturnsImmutableSnapshotAndGetStateValueUsesDefault() {
        Session session = session("s1", Map.of("k", "v"));

        assertThat(manager.getSessionState(session)).containsEntry("k", "v");
        assertThat(manager.getStateValue(session, "k", "dflt")).isEqualTo("v");
        assertThat(manager.getStateValue(session, "absent", "dflt")).isEqualTo("dflt");
    }

    @Test
    void bulkUpdateUserStateUpdatesEveryTrackedSession() {
        manager.trackSession(session("s1", Map.of()));
        manager.trackSession(session("s2", Map.of()));

        when(sessionService.getSession("app", "user", "s1", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session("s1", Map.of())));
        when(sessionService.getSession("app", "user", "s2", java.util.Optional.empty()))
                .thenReturn(Maybe.just(session("s2", Map.of())));
        when(sessionService.appendEvent(any(), any())).thenReturn(Single.just(Event.builder().build()));

        List<Map.Entry<String, Boolean>> results = manager.bulkUpdateUserState("user", Map.of("flag", true), "app")
                .toList().blockingGet();

        assertThat(results).hasSize(2);
        assertThat(results).allMatch(Map.Entry::getValue);
        verify(sessionService, times(2)).appendEvent(any(), argThat(event ->
                Boolean.TRUE.equals(event.actions().stateDelta().get("flag"))));
    }
}
