package com.agui.community.core.agent;

import java.util.Objects;

/**
 * A piece of contextual information supplied to an agent run, as carried on
 * {@link RunAgentInput}.
 *
 * @param description a human-readable description of what this context
 *                    represents (required)
 * @param value       the context value (required)
 * @see <a href="https://docs.ag-ui.com/concepts/agents">AG-UI Agents</a>
 */
public record Context(String description, String value) {

    public Context {
        Objects.requireNonNull(description, "description must not be null");
        Objects.requireNonNull(value, "value must not be null");
    }
}
