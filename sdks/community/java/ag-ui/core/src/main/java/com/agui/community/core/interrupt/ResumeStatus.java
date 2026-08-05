package com.agui.community.core.interrupt;

/**
 * Whether a user resolved a prior {@link Interrupt} or cancelled it.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public enum ResumeStatus {

    /** The user provided input; {@link Resume#payload()} carries the response. */
    RESOLVED("resolved"),

    /** The user abandoned the decision. */
    CANCELLED("cancelled");

    private final String value;

    ResumeStatus(String value) {
        this.value = value;
    }

    /**
     * @return the wire value of this status as used in the AG-UI protocol
     */
    public String value() {
        return value;
    }

    /**
     * Resolves a {@link ResumeStatus} from its wire value.
     *
     * @param value the protocol value (e.g. {@code "resolved"})
     * @return the matching status
     * @throws IllegalArgumentException if no status matches the given value
     */
    public static ResumeStatus fromValue(String value) {
        for (ResumeStatus status : values()) {
            if (status.value.equals(value)) {
                return status;
            }
        }
        throw new IllegalArgumentException("Unknown resume status: " + value);
    }
}
