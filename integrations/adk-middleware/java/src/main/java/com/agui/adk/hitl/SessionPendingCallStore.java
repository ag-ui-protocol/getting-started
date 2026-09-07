package com.agui.adk.hitl;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Session- and principal-scoped pending-call store with atomic in-process result claims.
 *
 * <p>This implementation is process-local. Instances sharing this store object receive atomic
 * exactly-once claims; deployments spanning processes must install a distributed atomic store.
 */
public final class SessionPendingCallStore implements PendingCallStore {
    private final ConcurrentMap<PendingCallScope, ScopeState> states = new ConcurrentHashMap<>();

    @Override
    public Completable persist(PendingToolCall call) {
        return Completable.fromAction(() -> {
            ScopeState state = states.computeIfAbsent(call.key().group().scope(), ignored -> new ScopeState());
            synchronized (state) {
                PendingToolCall existing = state.calls.putIfAbsent(call.key(), call);
                if (existing != null && !existing.equals(call)) {
                    throw new IllegalStateException("conflicting immutable pending call " + call.key().toolCallId());
                }
            }
        });
    }

    @Override
    public Completable remove(PendingCallGroupKey group, java.util.Set<String> toolCallIds) {
        return Completable.fromAction(() -> {
            ScopeState state = states.get(group.scope());
            if (state == null) {
                return;
            }
            synchronized (state) {
                toolCallIds.forEach(toolCallId -> {
                    PendingCallKey key = new PendingCallKey(group, toolCallId);
                    state.calls.remove(key);
                    state.results.remove(key);
                    state.identities.remove(key);
                });
            }
        });
    }

    @Override
    public Flowable<PendingToolCall> pending(PendingCallScope scope) {
        return Flowable.defer(() -> {
            ScopeState state = states.get(scope);
            if (state == null) {
                return Flowable.empty();
            }
            List<PendingToolCall> snapshot;
            synchronized (state) {
                snapshot = new ArrayList<>(state.calls.values());
            }
            return Flowable.fromIterable(snapshot);
        });
    }

    @Override
    public java.util.Set<String> acceptedResultIds(PendingCallScope scope) {
        ScopeState state = states.get(scope);
        if (state == null) {
            return java.util.Set.of();
        }
        synchronized (state) {
            return state.results.keySet().stream()
                    .map(PendingCallKey::toolCallId)
                    .collect(java.util.stream.Collectors.toUnmodifiableSet());
        }
    }

    @Override
    public Map<String, ConsumedToolResult> consumed(PendingCallScope scope) {
        ScopeState state = states.get(scope);
        if (state == null) {
            return Map.of();
        }
        synchronized (state) {
            return Map.copyOf(state.consumedResults);
        }
    }

    @Override
    public Single<PendingResultTransition> submitResult(PendingCallGroupKey group, NormalizedToolResult result) {
        return Single.fromCallable(() -> {
            ScopeState state = states.get(group.scope());
            if (state == null) {
                throw new IllegalArgumentException("unknown pending tool result");
            }
            synchronized (state) {
                return submitResultLocked(state, group, result);
            }
        });
    }

    @Override
    public Single<PendingResultTransition> submitResult(PendingCallScope scope, NormalizedToolResult result) {
        return submitScopedResult(scope, result, null);
    }

    @Override
    public Single<PendingResultTransition> submitResult(PendingCallScope scope, ConsumedToolResult result) {
        return submitScopedResult(scope, result.result(), result);
    }

    /**
     * Accepts a result after finding its one current scoped pending call.
     *
     * @param scope current principal-scoped session
     * @param result normalized browser result
     * @param identity original browser-message identity, when available
     * @return atomic buffered, duplicate, or ready outcome
     */
    private Single<PendingResultTransition> submitScopedResult(
            PendingCallScope scope, NormalizedToolResult result, ConsumedToolResult identity) {
        return Single.fromCallable(() -> {
            ScopeState state = states.get(scope);
            if (state == null) {
                throw new IllegalArgumentException("unknown pending tool result");
            }
            synchronized (state) {
                List<PendingCallKey> matches = state.calls.keySet().stream()
                        .filter(key -> key.toolCallId().equals(result.toolCallId()))
                        .toList();
                if (matches.size() != 1) {
                    throw new IllegalArgumentException("unknown pending tool result");
                }
                PendingCallKey key = matches.getFirst();
                ConsumedToolResult existingIdentity = state.identities.get(key);
                if (identity != null && existingIdentity != null && !existingIdentity.equals(identity)) {
                    throw new IllegalArgumentException("conflicting duplicate tool result");
                }
                if (identity != null) {
                    state.identities.putIfAbsent(key, identity);
                }
                return submitResultLocked(state, key.group(), result);
            }
        });
    }

    /**
     * Accepts one result while the owning scope monitor is held.
     *
     * @param state scoped mutable state
     * @param group current invocation group
     * @param result normalized browser response
     * @return atomic submission outcome
     */
    private static PendingResultTransition submitResultLocked(
            ScopeState state, PendingCallGroupKey group, NormalizedToolResult result) {
        PendingCallKey key = new PendingCallKey(group, result.toolCallId());
        PendingToolCall call = state.calls.get(key);
        if (call == null) {
            throw new IllegalArgumentException("unknown pending tool result");
        }
        BufferedToolResult accepted = new BufferedToolResult(call, result);
        BufferedToolResult existing = state.results.putIfAbsent(key, accepted);
        if (existing != null) {
            if (!existing.equals(accepted)) {
                throw new IllegalArgumentException("conflicting duplicate tool result");
            }
            ResumeClaim activeClaim = state.claimedGroups.get(group);
            if (activeClaim != null) {
                return new PendingResultTransition.Duplicate();
            }
            return claimIfReady(state, group, existing);
        }
        return claimIfReady(state, group, accepted);
    }

    /**
     * Claims a complete, unclaimed group or returns the accepted submission.
     *
     * @param state scoped mutable pending-call state
     * @param group invocation group to inspect
     * @param accepted accepted result to return while the group remains incomplete or claimed
     * @return an exclusive resume claim or the accepted result
     */
    private static PendingResultTransition claimIfReady(
            ScopeState state, PendingCallGroupKey group, BufferedToolResult accepted) {
        List<BufferedToolResult> groupResults = groupResults(state, group);
        if (groupResults.size() != groupCallCount(state, group) || state.claimedGroups.containsKey(group)) {
            return accepted;
        }
        List<com.agui.community.core.message.ToolMessage> originals = groupResults.stream()
                .map(result -> state.identities.get(result.call().key()))
                .map(identity -> identity == null ? null : identity.originalMessage())
                .toList();
        ResumeClaim claim = originals.stream().anyMatch(java.util.Objects::isNull)
                ? new ResumeClaim(group, groupResults)
                : new ResumeClaim(group, groupResults, originals);
        state.claimedGroups.put(group, claim);
        return claim;
    }

    @Override
    public Completable release(ResumeClaim claim) {
        return Completable.fromAction(() -> withState(claim, state -> {
            ResumeClaim current = state.claimedGroups.get(claim.group());
            if (!claim.equals(current)) {
                throw new IllegalStateException("resume claim is not active");
            }
            state.claimedGroups.remove(claim.group());
        }));
    }

    @Override
    public Completable markFinalizationPending(ResumeClaim claim) {
        return Completable.fromAction(() -> withState(claim, state -> {
            if (!claim.equals(state.claimedGroups.get(claim.group()))) {
                throw new IllegalStateException("resume claim is not active");
            }
            state.finalizationPendingGroups.add(claim.group());
        }));
    }

    @Override
    public Single<Boolean> finalizationPending(ResumeClaim claim) {
        return Single.fromCallable(() -> {
            ScopeState state = states.get(claim.group().scope());
            if (state == null) {
                throw new IllegalStateException("resume claim scope is absent");
            }
            synchronized (state) {
                if (!claim.equals(state.claimedGroups.get(claim.group()))) {
                    throw new IllegalStateException("resume claim is not active");
                }
                return state.finalizationPendingGroups.contains(claim.group());
            }
        });
    }

    @Override
    public Completable releaseFinalization(ResumeClaim claim) {
        return Completable.fromAction(() -> withState(claim, state -> {
            if (!claim.equals(state.claimedGroups.get(claim.group()))
                    || !state.finalizationPendingGroups.contains(claim.group())) {
                throw new IllegalStateException("resume finalization is not active");
            }
            state.claimedGroups.remove(claim.group());
        }));
    }

    @Override
    public Completable complete(ResumeClaim claim) {
        return Completable.fromAction(() -> withState(claim, state -> {
            ResumeClaim current = state.claimedGroups.get(claim.group());
            if (!claim.equals(current)) {
                throw new IllegalStateException("resume claim is not active");
            }
            claim.results().forEach(result -> {
                PendingCallKey key = result.call().key();
                state.consumedResults.put(key.toolCallId(), state.identities.getOrDefault(key,
                        new ConsumedToolResult(key.toolCallId(), key.toolCallId(), result.result())));
            });
            state.calls.keySet().removeIf(key -> key.group().equals(claim.group()));
            state.results.keySet().removeIf(key -> key.group().equals(claim.group()));
            state.identities.keySet().removeIf(key -> key.group().equals(claim.group()));
            state.finalizationPendingGroups.remove(claim.group());
            state.claimedGroups.remove(claim.group());
        }));
    }

    /**
     * Performs an action while holding the scope's atomic-state monitor.
     *
     * @param claim active exclusive claim
     * @param action state mutation
     */
    private void withState(ResumeClaim claim, StateAction action) {
        ScopeState state = states.get(claim.group().scope());
        if (state == null) {
            throw new IllegalStateException("resume claim scope is absent");
        }
        synchronized (state) {
            action.apply(state);
        }
    }

    /**
     * Returns accepted results in original persisted call order.
     *
     * @param state scoped mutable state
     * @param group current invocation group
     * @return stable result order
     */
    private static List<BufferedToolResult> groupResults(ScopeState state, PendingCallGroupKey group) {
        return state.calls.keySet().stream()
                .filter(key -> key.group().equals(group))
                .map(state.results::get)
                .filter(java.util.Objects::nonNull)
                .toList();
    }

    /**
     * Counts current pending calls in the one invocation group.
     *
     * @param state scoped mutable state
     * @param group current invocation group
     * @return number of required sibling calls
     */
    private static long groupCallCount(ScopeState state, PendingCallGroupKey group) {
        return state.calls.keySet().stream().filter(key -> key.group().equals(group)).count();
    }

    /** Action performed inside the monitor for one scope state. */
    @FunctionalInterface
    private interface StateAction {
        void apply(ScopeState state);
    }

    /** Mutable state guarded by its instance monitor. */
    private static final class ScopeState {
        private final Map<PendingCallKey, PendingToolCall> calls = new LinkedHashMap<>();
        private final Map<PendingCallKey, BufferedToolResult> results = new LinkedHashMap<>();
        private final Map<PendingCallKey, ConsumedToolResult> identities = new LinkedHashMap<>();
        private final Map<String, ConsumedToolResult> consumedResults = new LinkedHashMap<>();
        private final Map<PendingCallGroupKey, ResumeClaim> claimedGroups = new LinkedHashMap<>();
        private final java.util.Set<PendingCallGroupKey> finalizationPendingGroups = new java.util.HashSet<>();
    }
}
