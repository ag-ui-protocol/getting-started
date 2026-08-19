package com.agui.community.core.interrupt;

import java.util.List;
import java.util.Objects;

/**
 * The outcome of a run that paused for human input, carrying the interrupts
 * that must be answered — via {@link Resume} entries on the next
 * {@code RunAgentInput} — before the run can continue.
 *
 * @param interrupts the outstanding interrupts; never {@code null}
 *                   (copied to an unmodifiable list)
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public record InterruptOutcome(List<Interrupt> interrupts) implements RunOutcome {

    public InterruptOutcome {
        interrupts = Objects.isNull(interrupts) ? List.of() : List.copyOf(interrupts);
    }

    @Override
    public OutcomeType type() {
        return OutcomeType.INTERRUPT;
    }
}
