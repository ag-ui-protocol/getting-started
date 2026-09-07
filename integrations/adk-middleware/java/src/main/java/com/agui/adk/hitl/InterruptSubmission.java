package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Interrupt;
import java.util.List;
import java.util.Objects;

/** Atomic admission result for one official resume request. */
public sealed interface InterruptSubmission
        permits InterruptSubmission.Pending,
                InterruptSubmission.Claimed,
                InterruptSubmission.Cancelled,
                InterruptSubmission.Duplicate {
    /** Partial accepted group. */
    record Pending(List<Interrupt> outstanding) implements InterruptSubmission {
        /**
         * Copies the outstanding wire snapshots.
         * @param outstanding decisions still required
         */
        public Pending {
            outstanding = List.copyOf(outstanding);
        }
    }

    /** Complete exclusive group claim. */
    record Claimed(InterruptGroupClaim claim) implements InterruptSubmission {
        /**
         * Validates the acquired claim.
         * @param claim exclusive complete claim
         */
        public Claimed {
            claim = Objects.requireNonNull(claim, "claim");
        }
    }

    /** Atomically cancelled group. */
    record Cancelled(List<Interrupt> cancelled) implements InterruptSubmission {
        /**
         * Copies the cancelled wire snapshots.
         * @param cancelled decisions atomically cancelled
         */
        public Cancelled {
            cancelled = List.copyOf(cancelled);
        }
    }

    /** Strict idempotent replay. */
    record Duplicate() implements InterruptSubmission {}
}
