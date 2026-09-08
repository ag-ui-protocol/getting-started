package com.agui.community.spring.ai;

import java.util.Objects;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;

/**
 * A Spring AI {@link ToolCallback} for an AG-UI <em>client-side</em> tool. It
 * carries the tool's definition (name, description and JSON-Schema arguments) so
 * the model can request it, but it is never executed on the server: AG-UI tools
 * are run by the client that consumes the event stream. The agent therefore
 * registers these with internal tool execution disabled, and {@link #call} is
 * defensive only.
 */
final class AgUiToolCallback implements ToolCallback {

    private final ToolDefinition toolDefinition;

    AgUiToolCallback(ToolDefinition toolDefinition) {
        this.toolDefinition = Objects.requireNonNull(toolDefinition, "toolDefinition must not be null");
    }

    @Override
    public ToolDefinition getToolDefinition() {
        return toolDefinition;
    }

    @Override
    public String call(String toolInput) {
        throw new UnsupportedOperationException(
                "Tool '" + toolDefinition.name() + "' is an AG-UI client-side tool: it is advertised to the "
                        + "model but executed by the AG-UI client, not on the server");
    }
}
