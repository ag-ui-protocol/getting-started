package com.agui.community.core.interrupt;

/**
 * The outcome of an agent run, reported on
 * {@link com.agui.community.core.event.RunFinishedEvent}.
 *
 * <p>This is a sealed discriminated union: a run either completed normally
 * ({@link SuccessOutcome}) or paused to wait for human input
 * ({@link InterruptOutcome}). A {@code null} outcome on the event is treated as
 * a normal completion, for backward compatibility with runs that predate
 * interrupts.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public sealed interface RunOutcome permits SuccessOutcome, InterruptOutcome {

    /**
     * @return the discriminator identifying this outcome's concrete type
     */
    OutcomeType type();
}
