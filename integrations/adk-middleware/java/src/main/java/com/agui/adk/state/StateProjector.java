package com.agui.adk.state;

import com.google.adk.sessions.State;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Maintains the client-visible canonical state for one translated run. */
public final class StateProjector {

    /**
     * ADK's ephemeral per-invocation state prefix (Python {@code _ADKState.TEMP_PREFIX}). Python
     * strips these keys from the end-of-run snapshot (issue #1571) because they are scratch state
     * that no session service persists; a client that stored them would re-submit stale values.
     */
    private static final String TEMP_PREFIX = "temp:";

    private final Map<String, Object> state;

    /**
     * Creates a projector from a client-visible initial state.
     *
     * @param initial initial state, if any
     */
    public StateProjector(Map<String, Object> initial) {
        state = new LinkedHashMap<>();
        apply(initial, Map.of());
    }

    /**
     * Applies an ADK delta and predictive overlay, returning an immutable snapshot.
     * Ephemeral {@code temp:} keys are never retained or exposed; non-secret AG-UI identity and
     * bookkeeping markers remain client-visible for Python parity.
     *
     * @param delta ADK state delta
     * @param overlay predictive client state
     * @return canonical snapshot after both changes
     */
    public Map<String, Object> apply(Map<String, Object> delta, Map<String, Object> overlay) {
        applyDelta(delta);
        applyDelta(overlay);
        return snapshot();
    }

    /**
     * Applies an ADK delta without a predictive overlay.
     *
     * @param delta ADK state delta
     * @return canonical snapshot after the delta
     */
    public Map<String, Object> apply(Map<String, Object> delta) {
        return apply(delta, Map.of());
    }

    /**
     * Returns a canonical defensive snapshot.
     *
     * @return immutable client-visible state
     */
    public Map<String, Object> snapshot() {
        return Collections.unmodifiableMap(new LinkedHashMap<>(state));
    }

    /**
     * Replaces the retained projection with an authoritative session-state read and then applies
     * the predictive overlay. Both inputs pass through the same ephemeral-key filtering as deltas.
     *
     * @param authoritativeState state freshly read from the session service
     * @param predictiveOverlay accumulated client predictive state
     * @return canonical snapshot after replacement and overlay
     */
    public Map<String, Object> replace(
            Map<String, Object> authoritativeState, Map<String, Object> predictiveOverlay) {
        state.clear();
        return apply(authoritativeState, predictiveOverlay);
    }

    /**
     * Applies only client-visible delta entries to the retained state.
     *
     * @param delta state entries to apply
     */
    private void applyDelta(Map<String, Object> delta) {
        if (delta == null) {
            return;
        }
        delta.forEach((key, value) -> {
            if (protectedKey(key)) {
                return;
            }
            if (value == State.REMOVED) {
                state.remove(key);
            } else {
                state.put(key, defensiveCopy(value));
            }
        });
    }

    /**
     * Copies a JSON-like value so emitted protocol data never retains provider-owned containers.
     *
     * @param value provider-owned JSON-compatible value
     * @return immutable copied container or scalar
     */
    public static Object defensiveCopy(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<Object, Object> copy = new LinkedHashMap<>();
            map.forEach((key, nested) -> copy.put(key, defensiveCopy(nested)));
            return Collections.unmodifiableMap(copy);
        }
        if (value instanceof java.util.List<?> list) {
            List<Object> copy = new java.util.ArrayList<>(list.size());
            list.forEach(item -> copy.add(defensiveCopy(item)));
            return Collections.unmodifiableList(copy);
        }
        return value;
    }

    private static boolean protectedKey(String key) {
        return key != null && key.startsWith(TEMP_PREFIX);
    }
}
