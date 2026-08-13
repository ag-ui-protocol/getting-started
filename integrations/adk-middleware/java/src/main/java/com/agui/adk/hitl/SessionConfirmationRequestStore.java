package com.agui.adk.hitl;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Single;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** In-process principal-scoped storage for native ADK confirmation correlations. */
public final class SessionConfirmationRequestStore implements ConfirmationRequestStore {
    /** Process-local only; multi-process deployments must provide a shared atomic store. */
    private final ConcurrentMap<PendingCallScope, ConcurrentMap<String, Entry>> requests = new ConcurrentHashMap<>();

    /** One native correlation and its local lifecycle state. */
    private record Entry(String toolCallId, State state) {
        private Entry {
            java.util.Objects.requireNonNull(toolCallId, "toolCallId");
            java.util.Objects.requireNonNull(state, "state");
        }
    }

    /** Local confirmation continuation states. */
    private enum State {
        AVAILABLE,
        CLAIMED,
        COMPLETED
    }

    @Override
    public Completable persist(ConfirmationRequest request) {
        return Completable.fromAction(() -> {
            ConcurrentMap<String, Entry> scoped = requests.computeIfAbsent(
                    request.scope(), ignored -> new ConcurrentHashMap<>());
            Entry existing = scoped.putIfAbsent(request.invocationId(), new Entry(request.toolCallId(), State.AVAILABLE));
            if (existing != null && !existing.toolCallId().equals(request.toolCallId())) {
                throw new IllegalStateException("conflicting confirmation request");
            }
        });
    }

    @Override
    public Single<Boolean> claim(ConfirmationRequest request) {
        return Single.fromCallable(() -> transition(request, State.AVAILABLE, State.CLAIMED));
    }

    @Override
    public Completable release(ConfirmationRequest request) {
        return Completable.fromAction(() -> transition(request, State.CLAIMED, State.AVAILABLE));
    }

    @Override
    public Completable complete(ConfirmationRequest request) {
        return Completable.fromAction(() -> transition(request, State.CLAIMED, State.COMPLETED));
    }

    /**
     * Atomically moves one matching local correlation between lifecycle states.
     *
     * @param request exact principal-scoped correlation
     * @param expected current state required for transition
     * @param next state to write when matched
     * @return whether the transition occurred
     */
    private boolean transition(ConfirmationRequest request, State expected, State next) {
        ConcurrentMap<String, Entry> scoped = requests.get(request.scope());
        if (scoped == null) {
            return false;
        }
        return scoped.replace(request.invocationId(), new Entry(request.toolCallId(), expected),
                new Entry(request.toolCallId(), next));
    }
}
