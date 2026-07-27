package com.agui.community.core.message;

import java.util.Objects;

/**
 * The function invoked by a {@link ToolCall}.
 *
 * @param name      the name of the function to call (required)
 * @param arguments the arguments to the function, encoded as a JSON string
 *                  (required)
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
public record FunctionCall(String name, String arguments) {

    public FunctionCall {
        Objects.requireNonNull(name, "name must not be null");
        Objects.requireNonNull(arguments, "arguments must not be null");
    }
}
