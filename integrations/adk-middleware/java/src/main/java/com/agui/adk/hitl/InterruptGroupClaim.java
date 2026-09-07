package com.agui.adk.hitl;

import java.util.List;
import java.util.Objects;

/** Exclusive ownership of one fully answered interrupt group. */
public record InterruptGroupClaim(
        PendingCallGroupKey group,
        List<PendingInterrupt> interrupts,
        List<AcceptedResume> resumes) {
    /** Validates a complete group claim. */
    public InterruptGroupClaim {
        group = Objects.requireNonNull(group, "group");
        interrupts = List.copyOf(interrupts);
        resumes = List.copyOf(resumes);
        if (interrupts.isEmpty() || interrupts.size() != resumes.size()) {
            throw new IllegalArgumentException("claim must be complete");
        }
        for (PendingInterrupt interrupt : interrupts) {
            if (!group.equals(interrupt.group())) {
                throw new IllegalArgumentException("claim interrupts must belong to its group");
            }
        }
        for (int index = 0; index < interrupts.size(); index++) {
            if (!interrupts.get(index).interruptId().equals(resumes.get(index).interruptId())) {
                throw new IllegalArgumentException("claim responses must match interrupt order");
            }
        }
    }
}
