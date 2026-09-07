package com.agui.adk.tool;

import com.agui.adk.input.RawToolSchema;
import com.agui.adk.input.RunInputValidator;
import com.agui.community.core.tool.Tool;

import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Validates positional raw schemas and frontend/backend tool-name separation.
 */
public final class ToolNameValidator {

    public static final String DUPLICATE_TOOL_NAME = "DUPLICATE_TOOL_NAME";

    private ToolNameValidator() {
    }

    /**
     * Validates the one-to-one positional pairing between official tools and their raw schemas.
     *
     * @param tools official AG-UI tools
     * @param rawSchemas detached raw schemas
     */
    public static void validatePairs(List<Tool> tools, List<RawToolSchema> rawSchemas) {
        List<Tool> officialTools = tools == null ? List.of() : tools;
        List<RawToolSchema> schemas = rawSchemas == null ? List.of() : rawSchemas;
        validateUniqueFrontendToolNames(officialTools);
        Set<Integer> positions = new HashSet<>();
        for (RawToolSchema rawSchema : schemas) {
            if (!positions.add(rawSchema.position())) {
                throw RunInputValidator.invalidInput(
                        "duplicate raw tool schema position " + rawSchema.position());
            }
        }
        if (officialTools.size() != schemas.size()) {
            throw RunInputValidator.invalidInput("missing or extra raw tool schema pairs");
        }
        for (RawToolSchema rawSchema : schemas) {
            if (rawSchema.position() >= officialTools.size()) {
                throw RunInputValidator.invalidInput(
                        "raw tool schema position " + rawSchema.position()
                                + " is outside the official tool list");
            }
            Tool tool = officialTools.get(rawSchema.position());
            if (tool == null || !Objects.equals(tool.name(), rawSchema.name())) {
                throw RunInputValidator.invalidInput(
                        "raw tool schema " + rawSchema.name()
                                + " does not match official tool at position "
                                + rawSchema.position());
            }
        }
    }

    /**
     * Rejects duplicate frontend names in their request order.
     *
     * @param frontendTools request-defined frontend tools
     */
    private static void validateUniqueFrontendToolNames(List<Tool> frontendTools) {
        Set<String> names = new HashSet<>();
        for (Tool frontendTool : frontendTools) {
            if (frontendTool == null) {
                throw RunInputValidator.invalidInput("frontend tools must not contain null values");
            }
            if (!names.add(frontendTool.name())) {
                throw new IllegalArgumentException(DUPLICATE_TOOL_NAME + ": " + frontendTool.name());
            }
        }
    }

    /**
     * Rejects frontend names that collide with a configured backend tool.
     *
     * @param frontendTools request-defined frontend tools
     * @param backendToolNames static backend tool names
     */
    public static void validateNoBackendCollisions(
            List<Tool> frontendTools, Collection<String> backendToolNames) {
        Set<String> backendNames = Set.copyOf(backendToolNames);
        for (Tool frontendTool : frontendTools) {
            if (backendNames.contains(frontendTool.name())) {
                throw new IllegalArgumentException(
                        DUPLICATE_TOOL_NAME + ": " + frontendTool.name());
            }
        }
    }
}
