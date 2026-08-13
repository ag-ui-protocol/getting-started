package com.agui.adk.context;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.RunConfig;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RawToolSchema;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.adk.input.RunInputValidator;
import com.agui.adk.schema.GeminiSchemaNormalizer;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

/**
 * Creates immutable request metadata without mutating the base configuration or official input.
 */
public final class RunContextFactory {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final GeminiSchemaNormalizer SCHEMA_NORMALIZER = new GeminiSchemaNormalizer();

    private final String appName;
    private final String userId;
    private final String sessionId;
    private final RunInputValidator validator;
    private final Function<AdkAgUiRunContext, Map<String, Object>> metadataEnricher;

    /**
     * Creates a factory for one resolved request identity.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     */
    public RunContextFactory(String appName, String userId, String sessionId) {
        this(appName, userId, sessionId, new RunInputValidator(), context -> Map.of());
    }

    /**
     * Creates a factory with an explicit validator.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @param validator input validator
     */
    public RunContextFactory(
            String appName,
            String userId,
            String sessionId,
            RunInputValidator validator) {
        this(appName, userId, sessionId, validator, context -> Map.of());
    }

    /**
     * Creates a factory with an explicit validator and metadata enricher.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @param validator input validator
     * @param metadataEnricher extends the request metadata for each run, or null for none
     */
    public RunContextFactory(
            String appName,
            String userId,
            String sessionId,
            RunInputValidator validator,
            Function<AdkAgUiRunContext, Map<String, Object>> metadataEnricher) {
        this.appName = appName;
        this.userId = userId;
        this.sessionId = sessionId;
        this.validator = Objects.requireNonNull(validator, "validator");
        this.metadataEnricher = metadataEnricher;
    }

    /**
     * Extracts attached compatibility extensions and creates a request-specific configuration.
     *
     * @param baseConfig immutable base Google ADK configuration
     * @param input official AG-UI input, optionally carrying bounded extensions
     * @return copied request configuration containing the bridge context
     */
    public RunConfig createRequestConfig(RunConfig baseConfig, RunAgentInput input) {
        Objects.requireNonNull(baseConfig, "baseConfig");
        Objects.requireNonNull(input, "input");
        Optional<AdkRunExtensions> extensions = RunExtensionSupport.extract(input);
        rejectUnexpectedReservedForwardedProperty(input, extensions);
        return createRequestConfig(baseConfig, input, extensions.orElse(null), true);
    }

    /**
     * Creates a request configuration from explicit extensions without changing the supplied input.
     *
     * <p>The extensions are first attached to a copied official input and then extracted and
     * detached through the same bounded compatibility path used by wire-decoded requests.
     *
     * @param baseConfig immutable base Google ADK configuration
     * @param input official AG-UI input
     * @param extensions bounded compatibility extensions
     * @return copied request configuration containing the bridge context
     */
    public RunConfig createRequestConfig(
            RunConfig baseConfig,
            RunAgentInput input,
            AdkRunExtensions extensions) {
        Objects.requireNonNull(baseConfig, "baseConfig");
        Objects.requireNonNull(input, "input");
        Objects.requireNonNull(extensions, "extensions");

        Optional<AdkRunExtensions> attached = RunExtensionSupport.extract(input);
        if (attached.isPresent() && !attached.orElseThrow().equals(extensions)) {
            throw RunInputValidator.invalidInput(
                    "explicit extensions do not match attached extensions");
        }
        RunAgentInput attachedInput = attached.isPresent()
                ? input
                : RunExtensionSupport.attach(input, extensions);
        return createRequestConfig(baseConfig, attachedInput, extensions, true);
    }

    /**
     * Validates and creates the immutable context and copied RunConfig.
     *
     * @param baseConfig base run configuration
     * @param input source input
     * @param extensions optional extracted extensions
     * @param detachExtensions whether to remove the reserved forwarded property
     * @return copied request configuration
     */
    private RunConfig createRequestConfig(
            RunConfig baseConfig,
            RunAgentInput input,
            AdkRunExtensions extensions,
            boolean detachExtensions) {
        validator.validateIdentity(appName, userId, sessionId);
        validator.validate(input, extensions);
        if (baseConfig.customMetadata().containsKey(
                AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY)) {
            throw RunInputValidator.invalidInput(
                    "RunConfig metadata must not contain reserved key "
                            + AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
        }

        RunAgentInput detachedInput = detachExtensions && extensions != null
                ? RunExtensionSupport.detach(input)
                : input;
        java.util.List<Context> requestContext = input.context() == null
                ? java.util.List.of()
                : java.util.List.copyOf(input.context());
        AdkAgUiRunContext context = new AdkAgUiRunContext(
                appName,
                userId,
                input.threadId(),
                input.runId(),
                extensions == null ? null : extensions.parentRunId(),
                sessionId,
                detachedInput,
                resolveRawToolSchemas(detachedInput, extensions),
                new ToolCallLedger(),
                new CancellationToken(),
                RequestResourceRegistry.create(),
                UUID.randomUUID().toString(),
                requestContext,
                copiedForwardedProperties(detachedInput));

        Map<String, Object> metadata = new LinkedHashMap<>(baseConfig.customMetadata());
        metadata.put(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, context);
        if (metadataEnricher != null) {
            Map<String, Object> enriched = metadataEnricher.apply(context);
            if (enriched != null) {
                for (Map.Entry<String, Object> entry : enriched.entrySet()) {
                    if (entry.getKey().equals(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY)) {
                        throw new IllegalArgumentException(
                                "Run metadata enricher must not override reserved key "
                                        + AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
                    }
                    metadata.put(entry.getKey(), entry.getValue());
                }
            }
        }
        return baseConfig.toBuilder().customMetadata(metadata).build();
    }

    /**
     * Uses explicit raw schemas when supplied, otherwise reconstructs the standard root object
     * schema carried by each official AG-UI tool declaration.
     *
     * @param input detached official input
     * @param extensions optional compatibility extensions
     * @return positional raw schemas for frontend proxy creation
     */
    private static List<RawToolSchema> resolveRawToolSchemas(
            RunAgentInput input,
            AdkRunExtensions extensions) {
        if (extensions != null && !extensions.rawToolSchemas().isEmpty()) {
            return extensions.rawToolSchemas();
        }
        List<Tool> tools = input.tools() == null ? List.of() : input.tools();
        List<RawToolSchema> schemas = new ArrayList<>(tools.size());
        for (int position = 0; position < tools.size(); position++) {
            Tool tool = tools.get(position);
            ToolParameters parameters = tool.parameters();
            JsonNode rawRoot = parameters == null
                    ? OBJECT_MAPPER.valueToTree(Map.of(
                            "type", ToolParameters.TOOL_PARAMETERS_TYPE,
                            "properties", Map.of(),
                            "required", List.of()))
                    : OBJECT_MAPPER.valueToTree(parameters);
            JsonNode schema = SCHEMA_NORMALIZER.normalize(rawRoot);
            schemas.add(new RawToolSchema(position, tool.name(), schema));
        }
        return List.copyOf(schemas);
    }

    /**
     * Rejects a caller-owned value under the reserved forwarded-property key.
     *
     * @param input official input
     * @param extracted typed extension value
     */
    private static void rejectUnexpectedReservedForwardedProperty(
            RunAgentInput input,
            Optional<AdkRunExtensions> extracted) {
        if (input.forwardedProps() instanceof Map<?, ?> forwardedProps
                && forwardedProps.containsKey(AdkRunExtensions.FORWARDED_PROPS_KEY)
                && extracted.isEmpty()) {
            throw RunInputValidator.invalidInput(
                    "forwarded properties contain reserved key "
                            + AdkRunExtensions.FORWARDED_PROPS_KEY);
        }
    }

    /**
     * Copies the detached input''s forwarded properties as an immutable string-keyed map.
     *
     * @param detachedInput input with the reserved extension property already removed
     * @return immutable forwarded-property snapshot, or empty when absent
     */
    private static Map<String, Object> copiedForwardedProperties(RunAgentInput detachedInput) {
        Object forwarded = detachedInput.forwardedProps();
        if (forwarded == null) {
            return Map.of();
        }
        if (!(forwarded instanceof Map<?, ?> forwardedMap)) {
            throw RunInputValidator.invalidInput("forwardedProps must be null or a map");
        }
        Map<String, Object> copy = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : forwardedMap.entrySet()) {
            if (!(entry.getKey() instanceof String key)) {
                throw RunInputValidator.invalidInput("forwardedProps must contain only string keys");
            }
            copy.put(key, entry.getValue());
        }
        return java.util.Collections.unmodifiableMap(copy);
    }
}
