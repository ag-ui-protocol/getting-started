package com.agui.adk.message;

import com.google.adk.sessions.Session;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.DeveloperMessage;
import com.agui.community.core.message.FunctionCall;
import com.agui.community.core.message.SystemMessage;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MessageReservationStoreTest {

    @Test
    void holdsConcurrentDuplicateReservationsUntilCommitThenSuppressesFutureReservation() {
        MessageReservationStore store = new SessionMessageReservationStore();
        ResolvedSession session = session(Map.of());
        UserMessage message = new UserMessage("message-1", "first turn");

        MessageReservation first = store.reserve(session, List.of(message), "invocation-1").blockingGet();
        MessageReservation duplicate = store.reserve(session, List.of(message), "invocation-2").blockingGet();

        assertThat(first.messages()).containsExactly(message);
        assertThat(duplicate.messages()).isEmpty();

        store.commit(first).blockingAwait();
        MessageReservation afterCommit = store.reserve(session, List.of(message), "invocation-3").blockingGet();
        assertThat(afterCommit.messages()).isEmpty();
    }

    @Test
    void rollbackMakesMessageAvailableForRetry() {
        MessageReservationStore store = new SessionMessageReservationStore();
        ResolvedSession session = session(Map.of());
        UserMessage message = new UserMessage("message-1", "retry me");

        MessageReservation reservation = store.reserve(session, List.of(message), "invocation-1").blockingGet();
        store.rollback(reservation).blockingAwait();

        assertThat(store.reserve(session, List.of(message), "invocation-2").blockingGet().messages())
                .containsExactly(message);
    }

    @Test
    void recognizesPersistedProcessedIdCollectionShapes() {
        List<Object> persistedShapes = List.<Object>of(
                Set.of("already-processed"),
                List.of("already-processed"),
                new String[]{"already-processed"},
                "[\"already-processed\"]");
        UserMessage processed = new UserMessage("already-processed", "old");
        for (Object persistedShape : persistedShapes) {
            MessageReservationStore store = new SessionMessageReservationStore();
            ResolvedSession session = session(new ConcurrentHashMap<>(Map.of(
                    "processedMessageIds", persistedShape,
                    "_ag_ui_message_fingerprints", Map.of(
                            "already-processed", MessageFingerprint.of(processed)))));

            assertThat(store.reserve(session, List.of(processed), "invocation-1")
                    .blockingGet().messages()).isEmpty();
        }
    }

    @Test
    void fingerprintsEveryWireSignificantOfficialMessageField() {
        assertThat(MessageFingerprint.of(new UserMessage("id", "content", "first")))
                .isNotEqualTo(MessageFingerprint.of(new UserMessage("id", "content", "second")));
        assertThat(MessageFingerprint.of(new SystemMessage("id", "content", "first")))
                .isNotEqualTo(MessageFingerprint.of(new SystemMessage("id", "content", "second")));
        assertThat(MessageFingerprint.of(new DeveloperMessage("id", "content", "first")))
                .isNotEqualTo(MessageFingerprint.of(new DeveloperMessage("id", "content", "second")));
        assertThat(MessageFingerprint.of(new ToolMessage("id", "content", "call", "first")))
                .isNotEqualTo(MessageFingerprint.of(new ToolMessage("id", "content", "call", "second")));
        assertThat(MessageFingerprint.of(new AssistantMessage("id", "content", "first", List.of(
                new ToolCall("call", new FunctionCall("tool", "{\"a\":1}"))))))
                .isNotEqualTo(MessageFingerprint.of(new AssistantMessage("id", "content", "second", List.of(
                        new ToolCall("call", new FunctionCall("tool", "{\"a\":1}"))))));
        assertThat(MessageFingerprint.of(new AssistantMessage("id", "content", "first", List.of(
                new ToolCall("call", new FunctionCall("tool", "{\"a\":1}"))))))
                .isNotEqualTo(MessageFingerprint.of(new AssistantMessage("id", "content", "first", List.of(
                        new ToolCall("call", new FunctionCall("tool", "{\"a\":2}"))))));
    }

    @Test
    void evictingDeletedSessionAllowsRecreatedDirectSessionToReserveSameMessage() {
        MessageReservationStore store = new SessionMessageReservationStore();
        ResolvedSession deleted = session(Map.of());
        UserMessage message = new UserMessage("message-1", "first turn");
        store.commit(store.reserve(deleted, List.of(message), "old").blockingGet()).blockingAwait();

        store.evict(deleted.session()).blockingAwait();

        assertThat(store.reserve(session(Map.of()), List.of(message), "new").blockingGet().messages())
                .containsExactly(message);
    }

    @Test
    void freshStoreRejectsPersistedIdWhenFingerprintDiffersAndSuppressesSameContent() {
        UserMessage original = new UserMessage("message-1", "first", "alice");
        Map<String, Object> state = new ConcurrentHashMap<>(Map.of(
                "processedMessageIds", List.of("message-1"),
                "_ag_ui_message_fingerprints", Map.of("message-1", MessageFingerprint.of(original))));

        MessageReservationStore freshStore = new SessionMessageReservationStore();
        ResolvedSession reloadedSession = session(state);

        assertThat(freshStore.reserve(reloadedSession, List.of(original), "same").blockingGet().messages()).isEmpty();
        assertThatThrownBy(() -> freshStore.reserve(
                reloadedSession,
                List.of(new UserMessage("message-1", "first", "mallory")),
                "changed").blockingGet())
                .hasMessageContaining("message-1")
                .hasMessageContaining("different content");
    }

    @Test
    void historicalPersistedIdWithoutFingerprintRejectsReuseConservatively() {
        MessageReservationStore store = new SessionMessageReservationStore();
        ResolvedSession session = session(Map.of("processedMessageIds", Set.of("message-1")));

        assertThatThrownBy(() -> store.reserve(
                session, List.of(new UserMessage("message-1", "content")), "reuse").blockingGet())
                .hasMessageContaining("message-1")
                .hasMessageContaining("fingerprint");
    }

    private static ResolvedSession session(Map<String, Object> state) {
        Session session = Session.builder("session-1")
                .appName("app")
                .userId("user")
                .state(state)
                .build();
        return new ResolvedSession(
                session,
                new SessionMapping(new SessionMappingKey("app", "user", "thread"), "session-1"));
    }
}
