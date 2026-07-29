package com.agui.community.core.interrupt;

/**
 * The kind of {@link RunOutcome} a run finished with.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public enum OutcomeType {

    /** The run completed normally. */
    SUCCESS("success"),

    /** The run paused to wait for human input. */
    INTERRUPT("interrupt");

    private final String value;

    OutcomeType(String value) {
        this.value = value;
    }

    /**
     * @return the wire value of this outcome type as used in the AG-UI protocol
     */
    public String value() {
        return value;
    }

    /**
     * Resolves an {@link OutcomeType} from its wire value.
     *
     * @param value the protocol value (e.g. {@code "interrupt"})
     * @return the matching outcome type
     * @throws IllegalArgumentException if no outcome type matches the given value
     */
    public static OutcomeType fromValue(String value) {
        for (OutcomeType type : values()) {
            if (type.value.equals(value)) {
                return type;
            }
        }
        throw new IllegalArgumentException("Unknown outcome type: " + value);
    }
}
