package com.agui.community.core.interrupt;

import java.util.Objects;

/**
 * A user's response to a prior {@link Interrupt}, supplied on the next run via
 * {@code RunAgentInput.resume()}.
 *
 * @param interruptId the {@link Interrupt#id()} this entry answers (required)
 * @param status      whether the user provided input or abandoned the decision
 *                    (required)
 * @param payload     the user's response when {@link ResumeStatus#RESOLVED}
 *                    (validated against the interrupt's schema), or {@code null}
 *                    (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public record Resume(String interruptId, ResumeStatus status, Object payload) {

    public Resume {
        Objects.requireNonNull(interruptId, "interruptId must not be null");
        Objects.requireNonNull(status, "status must not be null");
    }
}
