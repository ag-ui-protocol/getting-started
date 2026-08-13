package com.agui.adk.history;

import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * Pure port of the multi-long-running-operation resume-gating set arithmetic from the Python
 * {@code ADKAgent._handle_tool_result_submission}. It scopes the pending-tool-call gate to the
 * current model turn, ignoring leaked/orphaned pending state.
 *
 * <p>{@code pending_tool_calls} is thread-global, so a leftover/orphaned entry from an earlier
 * turn (e.g. a call the model re-issued under a fresh id, orphaning the original) would otherwise
 * gate EVERY future submission forever. This scopes the gate to this turn: a leftover pending call
 * only blocks the resume if it shares the arriving results' invocation id - i.e. it is a genuine
 * sibling long-running call of the same turn. Pending/arriving ids are client-facing while session
 * FunctionCall events store ADK-persisted ids, so the client-to-persisted remap is applied before
 * each invocation lookup. If the arriving turn's invocation ids can't be resolved, the unscoped set
 * is kept (preserves the multi-LRO gate rather than risking a premature resume).
 */
public final class LroResumeGating {

    private LroResumeGating() {
    }

    /**
     * Returns the still-pending ids that genuinely belong to the arriving model turn.
     *
     * @param pendingBefore      thread-global pending client-facing call ids (before applying this
     *                           submission's results)
     * @param arrivingIds        the arriving tool-result call ids (client-facing)
     * @param remap              client-facing to ADK-persisted call-id remap (may be empty)
     * @param findInvocationId   resolves the ADK-persisted id to its session event's invocation id
     * @return the scoped still-pending set (empty when all arriving results answer this turn)
     */
    public static Set<String> scopePendingToTurn(Set<String> pendingBefore, Set<String> arrivingIds,
                                                 Map<String, String> remap,
                                                 Function<String, Optional<String>> findInvocationId) {
        Set<String> stillPendingAfter = new HashSet<>(pendingBefore);
        stillPendingAfter.removeAll(arrivingIds);
        if (stillPendingAfter.isEmpty()) {
            return stillPendingAfter;
        }
        // Invocation ids of this arriving turn's results (via the persisted-id remap).
        Set<String> arrivingInvocations = new HashSet<>();
        for (String arrivingId : arrivingIds) {
            String persisted = remap != null ? remap.getOrDefault(arrivingId, arrivingId) : arrivingId;
            Optional<String> invocation = findInvocationId.apply(persisted);
            invocation.ifPresent(arrivingInvocations::add);
        }
        if (arrivingInvocations.isEmpty()) {
            // Can't resolve the arriving turn - keep the unscoped set (preserves the gate).
            return stillPendingAfter;
        }
        // Keep only pending ids whose invocation is one of this turn's arriving invocations
        // (genuine sibling long-running calls); orphaned/leaked ids are excluded.
        Set<String> sameTurn = new HashSet<>();
        for (String pendingId : stillPendingAfter) {
            String persisted = remap != null ? remap.getOrDefault(pendingId, pendingId) : pendingId;
            Optional<String> invocation = findInvocationId.apply(persisted);
            if (invocation.isPresent() && arrivingInvocations.contains(invocation.get())) {
                sameTurn.add(pendingId);
            }
        }
        return sameTurn;
    }
}
