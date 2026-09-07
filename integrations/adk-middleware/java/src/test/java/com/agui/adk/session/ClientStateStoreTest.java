package com.agui.adk.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.sessions.Session;
import com.google.adk.sessions.State;
import com.agui.adk.testsupport.JsonRoundTripSessionService;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;

class ClientStateStoreTest {

    private final ClientStateStore store = new ClientStateStore(new ObjectMapper());

    @Test
    void preservesTopLevelAndNestedNullInCanonicalJson() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("value", null);
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("topLevel", null);
        state.put("nested", nested);

        Map<String, Object> persisted = store.persistClientState(Map.of(), state);

        assertThat(persisted.get(SessionStateKeys.CLIENT_STATE)).isEqualTo(
                "{\"nested\":{\"value\":null},\"topLevel\":null}");
        assertThat(store.snapshot(persisted)).containsEntry("topLevel", null);
        assertThat(((Map<?, ?>) store.snapshot(persisted).get("nested")).get("value")).isNull();
    }

    @Test
    void keepsAdkRemovalMarkersDistinctFromTopLevelAndNestedJsonNull() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("jsonNull", null);
        nested.put("removed", State.REMOVED);
        Map<String, Object> clientState = new LinkedHashMap<>();
        clientState.put("topLevelJsonNull", null);
        clientState.put("removed", State.REMOVED);
        clientState.put("nested", nested);

        Map<String, Object> persisted = store.persistClientState(Map.of(), clientState);

        assertThat(persisted.get(SessionStateKeys.CLIENT_STATE)).isEqualTo(
                "{\"nested\":{\"jsonNull\":null},\"topLevelJsonNull\":null}");
        assertThat(store.snapshot(persisted)).containsEntry("topLevelJsonNull", null)
                .doesNotContainKey("removed");
        Map<?, ?> nestedSnapshot = (Map<?, ?>) store.snapshot(persisted).get("nested");
        assertThat(nestedSnapshot.get("jsonNull")).isNull();
        assertThat(nestedSnapshot.containsKey("removed")).isFalse();
    }

    @Test
    void filtersProtectedKeysFromClientSnapshotsAndWrites() {
        Map<String, Object> requestState = Map.of(
                "visible", "yes",
                SessionStateKeys.CLIENT_STATE, "attempted overwrite",
                "_ag_ui_pending_calls", "attempted overwrite");

        Map<String, Object> persisted = store.persistClientState(Map.of(), requestState);

        assertThat(store.snapshot(persisted)).containsOnly(Map.entry("visible", "yes"));
        assertThat(persisted).doesNotContainKey("_ag_ui_pending_calls");
    }

    @Test
    void restoresCanonicalClientStateAfterJsonSessionServiceRoundTrip() {
        JsonRoundTripSessionService service = new JsonRoundTripSessionService();
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("value", null);
        Map<String, Object> persisted = store.persistClientState(Map.of(), Map.of(
                "items", List.of("a", "b"), "nested", nested));

        Session session = service.createSession("app", "user", new ConcurrentHashMap<>(persisted), null)
                .blockingGet();

        assertThat(store.snapshot(session.state())).containsEntry("items", List.of("a", "b"));
        Map<?, ?> nestedSnapshot = (Map<?, ?>) store.snapshot(session.state()).get("nested");
        assertThat(nestedSnapshot.get("value")).isNull();
        assertThat(session.state()).containsKey(SessionStateKeys.CLIENT_STATE);
    }

    @Test
    void replacesRequestContextWithoutPersistingItInClientState() {
        Map<String, Object> initial = store.persistContext(Map.of(), Map.of("request", "one"));
        Map<String, Object> replaced = store.persistContext(initial, Map.of("request", "two"));

        assertThat(store.context(replaced)).containsOnly(Map.entry("request", "two"));
        assertThat(store.snapshot(replaced)).isEmpty();
    }

    @Test
    void readsPersistentCollectionsFromSetListAndJsonArray() {
        assertThat(store.stringSet(Map.of("ids", List.of("a", "b")), "ids")).containsExactlyInAnyOrder("a", "b");
        assertThat(store.stringSet(Map.of("ids", java.util.Set.of("a", "b")), "ids")).containsExactlyInAnyOrder("a", "b");
        assertThat(store.stringSet(Map.of("ids", new String[] {"a", "b"}), "ids")).containsExactlyInAnyOrder("a", "b");
        assertThat(store.stringSet(Map.of("ids", "[\"a\",\"b\"]"), "ids")).containsExactlyInAnyOrder("a", "b");
    }
}
