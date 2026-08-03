package com.agui.community.core.tool;

import java.util.Objects;

/**
 * A tool that an AG-UI agent can call. A tool is defined by a name, a
 * human-readable description and a JSON Schema describing its arguments.
 *
 * <p>When an agent invokes a tool it emits a {@code ToolCall} (see
 * {@link com.agui.community.core.message.ToolCall}); the result is fed back into
 * the conversation as a {@link com.agui.community.core.message.ToolMessage}.
 *
 * @param name        the unique identifier of the tool (required)
 * @param description a human-readable explanation of what the tool does
 *                    (required)
 * @param parameters  the JSON Schema describing the tool's arguments (required)
 * @see <a href="https://docs.ag-ui.com/concepts/tools">AG-UI Tools</a>
 */
public record Tool(String name, String description, ToolParameters parameters) {

    public Tool {
        Objects.requireNonNull(name, "name must not be null");
        Objects.requireNonNull(description, "description must not be null");
        Objects.requireNonNull(parameters, "parameters must not be null");
    }
}
