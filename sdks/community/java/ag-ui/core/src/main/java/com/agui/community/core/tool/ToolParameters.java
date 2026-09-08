package com.agui.community.core.tool;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * The JSON Schema describing the arguments a {@link Tool} accepts. This models
 * the {@code object} schema used by AG-UI tool definitions.
 *
 * @param type       the schema type; defaults to {@value #TOOL_PARAMETERS_TYPE} when
 *                   {@code null}
 * @param properties the parameter definitions keyed by name, where each value
 *                   is a JSON Schema fragment; never {@code null} (defaults to
 *                   an empty, unmodifiable map, since JSON Schema treats
 *                   {@code properties} as optional)
 * @param required   the names of the required parameters; never {@code null}
 *                   (defaults to an empty, unmodifiable list, since JSON Schema
 *                   treats {@code required} as optional)
 * @see <a href="https://docs.ag-ui.com/concepts/tools">AG-UI Tools</a>
 */
public record ToolParameters(String type, Map<String, Object> properties, List<String> required) {

    /** The default (and only AG-UI supported) schema type for tool parameters. */
    public static final String TOOL_PARAMETERS_TYPE = "object";

    public ToolParameters {
        type = Objects.isNull(type) ? TOOL_PARAMETERS_TYPE : type;
        properties = Objects.isNull(properties) ? Map.of() : Map.copyOf(properties);
        required = Objects.isNull(required) ? List.of() : List.copyOf(required);
    }

    /**
     * Creates a tool parameters schema of type {@value #TOOL_PARAMETERS_TYPE}.
     *
     * @param properties the parameter definitions keyed by name
     * @param required   the names of the required parameters
     */
    public ToolParameters(Map<String, Object> properties, List<String> required) {
        this(TOOL_PARAMETERS_TYPE, properties, required);
    }
}
