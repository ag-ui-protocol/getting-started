package com.agui.adk.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.google.adk.sessions.Session;
import com.google.adk.sessions.State;
import com.agui.adk.testsupport.VertexLikeSessionService;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import org.junit.jupiter.api.Test;

/**
 * Audit finding m-01 — proof that full null-value carriage parity is <em>impossible</em> with
 * stock google-adk 1.7.0, and that the {@link RequestStateSessionService} skip behavior is the
 * only non-failing stock-representable option.
 *
 * <p>Python {@code request_state_service._inject} runs {@code session.state[k] = v} for every
 * pending {@code temp:} entry, so a {@code temp:*} = {@code None} value makes the key observable
 * with {@code None}. The Java wrapper previously crashed before the invocation because
 * {@code Map.copyOf} rejects null values (the original m-01 impact). Commit 6630507 fixed the
 * crash by copying pending state with {@code LinkedHashMap} and skipping null values on
 * injection. The remaining question is whether the key can be made observable with a null value
 * on a stock-ADK {@code Session}; these tests prove it cannot:
 *
 * <ul>
 *   <li>{@link Session#state()} is {@code com.google.adk.sessions.State}, a
 *       {@code ConcurrentMap} whose backing map <em>and</em> delta map are
 *       {@code ConcurrentHashMap}s — {@code put(k, null)} throws {@link NullPointerException}
 *       (verified by {@code javap} on {@code google-adk-1.7.0.jar} {@code State.class}: the
 *       {@code put} delegates to the {@code ConcurrentMap} fields, and
 *       {@code toConcurrentMap} builds {@code ConcurrentHashMap}s);</li>
 *   <li>{@code State}'s own copy constructor does not carry null values either: the
 *       {@code toConcurrentMap} lambda substitutes the internal {@code REMOVED} tombstone
 *       ({@code State.REMOVED}) for a null value, so a session built from a null-valued map
 *       does not hold a null — it holds the ADK's deletion marker, which downstream merge and
 *       projection logic would interpret as a removal, not as Python's {@code None};</li>
 *   <li>{@code InMemorySessionService} re-wraps state in a fresh {@code ConcurrentHashMap} on
 *       every read ({@code copySession}), so any null value in a returned session would crash
 *       the next read of the same session.</li>
 * </ul>
 *
 * <p>Conclusion: carrying {@code temp:*} = null as an observable key would require forking the
 * ADK {@code Session}/{@code State} implementation. The wrapper skips null-valued keys instead:
 * the key is absent, the invocation never fails, and {@code Map.get} returns {@code null} on the
 * primary read path exactly as Python's {@code None} does — a documented divergence, not parity.
 */
class RequestStateSessionServiceNullValueProofTest {

    private static final String APP = "app";
    private static final String USER = "user";

    @Test
    void stockAdkSessionStatePutWithNullValueThrowsNpe() {
        Session session = Session.builder("s1").appName(APP).userId(USER)
                .state(new ConcurrentHashMap<>()).build();

        // com.google.adk.sessions.State is a ConcurrentMap backed by ConcurrentHashMap
        // (state and delta maps): a null value cannot be represented, so the very operation
        // Python performs unconditionally (session.state[k] = None) throws in Java.
        assertThat(session.state()).isInstanceOf(ConcurrentMap.class);
        assertThatThrownBy(() -> session.state().put("temp:optional", null))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void stockAdkStateConstructorSubstitutesRemovedTombstoneForNullNotANull() {
        Map<String, Object> withNull = new HashMap<>();
        withNull.put("temp:optional", null);
        withNull.put("temp:token", "abc");

        // State(Map) copies through the ADK's toConcurrentMap lambda which maps null values to
        // the internal REMOVED tombstone — the ADK has no concept of a null state value.
        Session session = Session.builder("s2").appName(APP).userId(USER).state(withNull).build();

        assertThat(session.state().get("temp:optional")).isSameAs(State.REMOVED);
        assertThat(session.state().get("temp:token")).isEqualTo("abc");
        // The tombstone is not a null and is semantically a deletion marker; injecting it as a
        // "null value" would fabricate sentinel behavior and diverge further (downstream merge
        // treats REMOVED as a removal), which is exactly why the wrapper does not use it.
        assertThat(State.REMOVED).isNotNull();
    }

    @Test
    void wrapperSkipsNullValuedTempKeysOnThePublicInjectionPath() {
        VertexLikeSessionService delegate = new VertexLikeSessionService(true);
        RequestStateSessionService service = new RequestStateSessionService(delegate);
        service.createSession(APP, USER, new ConcurrentHashMap<>(Map.of("a", 1)), "s1").blockingGet();

        Map<String, Object> tempWithNull = new HashMap<>();
        tempWithNull.put("temp:optional", null);
        tempWithNull.put("temp:token", "abc");
        service.setPendingTempState(APP, USER, "s1", tempWithNull);

        Session fetched = service.getSession(APP, USER, "s1", Optional.empty()).blockingGet();
        // Non-null sibling is injected; the null-valued key is omitted (stock ADK State cannot
        // hold it — see the two proofs above). Python would keep the key with None, so
        // containsKey/keySet observably differ; Map.get still returns null in both languages.
        assertThat(fetched.state().get("temp:token")).isEqualTo("abc");
        assertThat(fetched.state().containsKey("temp:optional")).isFalse();
        assertThat(fetched.state().get("temp:optional")).isNull();
        assertThat(fetched.state().get("a")).isEqualTo(1);
    }
}
