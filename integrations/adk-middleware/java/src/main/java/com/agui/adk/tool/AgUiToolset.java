package com.agui.adk.tool;

import com.google.adk.agents.ReadonlyContext;
import com.google.adk.tools.BaseTool;
import com.google.adk.tools.BaseToolset;
import com.google.adk.tools.ToolPredicate;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.input.RawToolSchema;
import com.agui.adk.schema.GeminiSchemaConverter;
import com.agui.community.core.tool.Tool;
import io.reactivex.rxjava3.core.Flowable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * Stateless ADK toolset exposing only frontend tools attached to the current request metadata.
 */
public final class AgUiToolset implements BaseToolset {

    private static final Logger LOGGER = LoggerFactory.getLogger(AgUiToolset.class);

    private final GeminiSchemaConverter schemaConverter;
    private final Object toolFilter;
    private final String toolNamePrefix;

    /**
     * Creates a toolset with the standard Gemini schema converter.
     */
    public AgUiToolset() {
        this(new GeminiSchemaConverter(), null, null);
    }

    /**
     * Creates a toolset with an allowlist and optional public name prefix.
     *
     * @param toolFilter original frontend tool names to expose
     * @param toolNamePrefix prefix applied after filtering
     */
    public AgUiToolset(List<String> toolFilter, String toolNamePrefix) {
        this(new GeminiSchemaConverter(), List.copyOf(toolFilter), toolNamePrefix);
    }

    /**
     * Creates a toolset with a context-aware predicate and optional public name prefix.
     *
     * @param toolFilter predicate applied to original frontend tools
     * @param toolNamePrefix prefix applied after filtering
     */
    public AgUiToolset(ToolPredicate toolFilter, String toolNamePrefix) {
        this(new GeminiSchemaConverter(), Objects.requireNonNull(toolFilter, "toolFilter"), toolNamePrefix);
    }

    /**
     * Creates a toolset with an explicit schema converter.
     *
     * @param schemaConverter request-schema converter
     */
    public AgUiToolset(GeminiSchemaConverter schemaConverter) {
        this(schemaConverter, null, null);
    }

    /**
     * Internal constructor centralizing immutable toolset configuration.
     *
     * @param schemaConverter request schema converter
     * @param toolFilter optional ADK filter
     * @param toolNamePrefix optional exposed-name prefix
     */
    private AgUiToolset(GeminiSchemaConverter schemaConverter, Object toolFilter, String toolNamePrefix) {
        this.schemaConverter = Objects.requireNonNull(schemaConverter, "schemaConverter");
        this.toolFilter = toolFilter;
        this.toolNamePrefix = toolNamePrefix == null || toolNamePrefix.isBlank() ? null : toolNamePrefix;
    }

    /**
     * Reads only the current invocation metadata and returns new request-specific proxy tools.
     *
     * @param context current ADK invocation context
     * @return frontend proxy tools for this request
     */
    @Override
    public Flowable<BaseTool> getTools(ReadonlyContext context) {
        AdkAgUiRunContext runContext = AdkAgUiRunContext.from(Objects.requireNonNull(context, "context"))
                .orElseThrow(() -> new IllegalStateException("missing AG-UI run context metadata"));
        List<Tool> tools = runContext.input().tools() == null ? List.of() : runContext.input().tools();
        List<RawToolSchema> schemas = runContext.rawToolSchemas();
        ToolNameValidator.validatePairs(tools, schemas);
        List<ClientProxyTool> exposed = schemas.stream()
                .sorted(Comparator.comparingInt(RawToolSchema::position))
                .map(schema -> clientProxyOrNull(tools.get(schema.position()), schema))
                .filter(Objects::nonNull)
                .filter(tool -> isToolSelected(tool, toolFilter, context))
                .map(this::prefix)
                .toList();
        FrontendToolExposure.from(runContext).addAll(
                exposed.stream().map(BaseTool::name).toList());
        return Flowable.fromIterable(exposed);
    }

    private ClientProxyTool prefix(ClientProxyTool tool) {
        return toolNamePrefix == null ? tool : tool.withName(toolNamePrefix + '_' + tool.name());
    }

    /**
     * Converts one frontend tool independently so invalid siblings do not abort discovery.
     *
     * @param tool frontend tool metadata
     * @param rawSchema positional raw schema
     * @return converted proxy, or {@code null} when this schema is invalid
     */
    private ClientProxyTool clientProxyOrNull(Tool tool, RawToolSchema rawSchema) {
        try {
            return new ClientProxyTool(
                    tool.name(), tool.description(), schemaConverter.convert(rawSchema.schema()));
        } catch (RuntimeException error) {
            LOGGER.warn("Skipping frontend tool '{}' because its schema is invalid", tool.name(), error);
            return null;
        }
    }

    /**
     * This singleton toolset owns no request resources.
     */
    @Override
    public void close() {
        // Request state is attached to RunConfig metadata, never to this toolset.
    }
}
