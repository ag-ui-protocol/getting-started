package com.agui.adk;

import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.session.SessionStateKeys;
import com.agui.adk.session.ThreadSessionMappingStore;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionManagerBulkDeletionTest {

    @Test
    void bulkDeletionHydratesListedSessionsAndUsesTheConfirmedDeletionTransaction() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        ThreadSessionMappingStore mappings = mock(ThreadSessionMappingStore.class);
        MessageReservationStore reservations = mock(MessageReservationStore.class);
        Session listed = session("generated", Map.of());
        Session authoritative = session("generated", new ConcurrentHashMap<>());
        authoritative.state().put(SessionStateKeys.THREAD_ID, "thread");
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(listed)).build()));
        when(sessions.getSession("app", "user", "generated", java.util.Optional.empty()))
                .thenReturn(Maybe.just(authoritative));
        when(memory.addSessionToMemory(authoritative)).thenReturn(Completable.complete());
        when(memory.addSessionToMemory(listed)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "generated")).thenReturn(Completable.complete());
        when(reservations.evict(authoritative)).thenReturn(Completable.complete());
        when(reservations.evict(listed)).thenReturn(Completable.complete());
        when(mappings.invalidate(new SessionMappingKey("app", "user", "thread")))
                .thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory, mappings, new AdkAgUiOptions(false));
        manager.registerMessageReservationStore(reservations);

        manager.deleteAllUserAppNameSessions("app", "user").blockingAwait();

        InOrder ordered = inOrder(sessions, memory, reservations, mappings);
        ordered.verify(sessions).getSession("app", "user", "generated", java.util.Optional.empty());
        ordered.verify(memory).addSessionToMemory(authoritative);
        ordered.verify(sessions).deleteSession("app", "user", "generated");
        ordered.verify(reservations).evict(authoritative);
        ordered.verify(mappings).invalidate(new SessionMappingKey("app", "user", "thread"));
        verify(memory, never()).addSessionToMemory(listed);
    }

    @Test
    void bulkDeletionTreatsAListedSessionThatVanishesBeforeHydrationAsClean() {
        BaseSessionService sessions = mock(BaseSessionService.class);
        BaseMemoryService memory = mock(BaseMemoryService.class);
        Session listed = session("gone", Map.of());
        when(sessions.listSessions("app", "user"))
                .thenReturn(Single.just(ListSessionsResponse.builder().sessions(List.of(listed)).build()));
        when(sessions.getSession("app", "user", "gone", java.util.Optional.empty()))
                .thenReturn(Maybe.empty());
        when(memory.addSessionToMemory(listed)).thenReturn(Completable.complete());
        when(sessions.deleteSession("app", "user", "gone")).thenReturn(Completable.complete());
        SessionManager manager = new SessionManager(sessions, memory);

        manager.deleteAllUserAppNameSessions("app", "user").blockingAwait();

        verify(memory, never()).addSessionToMemory(any());
        verify(sessions, never()).deleteSession(any(), any(), any());
    }

    private static Session session(String id, Map<String, Object> state) {
        return Session.builder(id).appName("app").userId("user").state(state).build();
    }
}
