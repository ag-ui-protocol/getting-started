package com.agui.community.core.interrupt;

/**
 * The outcome of a run that completed normally. On the wire this is
 * {@code {"type":"success"}}.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public record SuccessOutcome() implements RunOutcome {

    @Override
    public OutcomeType type() {
        return OutcomeType.SUCCESS;
    }
}
