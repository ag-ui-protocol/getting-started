package com.agui.adk.context;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.adk.agents.ReadonlyContext;
import com.google.adk.agents.RunConfig;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.adk.input.RawToolSchema;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Immutable request-owned values exposed to Google ADK components through run metadata.
 *
 * @param appName Google ADK application name
 * @param userId Google ADK user identifier
 * @param threadId AG-UI thread identifier
 * @param runId AG-UI run identifier
 * @param parentRunId optional AG-UI parent run identifier
 * @param sessionId Google ADK session identifier
 * @param input detached official AG-UI input
 * @param rawToolSchemas raw root tool schemas unavailable in the official core model
 * @param toolCallLedger request-local tool call identity ledger
 * @param cancellation request cancellation state
 * @param resources request-owned closeable resources
 * @param invocationId bridge invocation identifier
 * @param requestContext AG-UI request context entries consumed from the ADK request
 * @param forwardedProperties forwarded properties consumed from the ADK request
 */
public record AdkAgUiRunContext(
        String appName,
        String userId,
        String threadId,
        String runId,
        String parentRunId,
        String sessionId,
        RunAgentInput input,
        List<RawToolSchema> rawToolSchemas,
        ToolCallLedger toolCallLedger,
        CancellationToken cancellation,
        RequestResourceRegistry resources,
        String invocationId,
        List<Context> requestContext,
        Map<String, Object> forwardedProperties) {

    public static final String RUN_CONFIG_METADATA_KEY = "agUi4jAdkRunContext";

    /**
     * Defensively captures request-owned collections.
     */
    public AdkAgUiRunContext {
        appName = Objects.requireNonNull(appName, "appName");
        userId = Objects.requireNonNull(userId, "userId");
        threadId = Objects.requireNonNull(threadId, "threadId");
        runId = Objects.requireNonNull(runId, "runId");
        sessionId = Objects.requireNonNull(sessionId, "sessionId");
        input = immutableInput(Objects.requireNonNull(input, "input"));
        rawToolSchemas = List.copyOf(rawToolSchemas);
        toolCallLedger = Objects.requireNonNull(toolCallLedger, "toolCallLedger");
        cancellation = Objects.requireNonNull(cancellation, "cancellation");
        resources = Objects.requireNonNull(resources, "resources");
        invocationId = Objects.requireNonNull(invocationId, "invocationId");
        requestContext = requestContext == null ? List.of() : List.copyOf(requestContext);
        forwardedProperties = forwardedProperties == null
                ? Map.of()
                : immutableStringMap(forwardedProperties);
    }

    /**
     * Creates a context with no request context or forwarded-property consumption.
     *
     * <p>Retained for callers that only need the bridge-local request identity and do not draw
     * context or forwarded properties from the ADK request.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     * @param parentRunId optional AG-UI parent run identifier
     * @param sessionId Google ADK session identifier
     * @param input detached official AG-UI input
     * @param rawToolSchemas raw root tool schemas unavailable in the official core model
     * @param toolCallLedger request-local tool call identity ledger
     * @param cancellation request cancellation state
     * @param resources request-owned closeable resources
     * @param invocationId bridge invocation identifier
     */
    public AdkAgUiRunContext(
            String appName,
            String userId,
            String threadId,
            String runId,
            String parentRunId,
            String sessionId,
            RunAgentInput input,
            List<RawToolSchema> rawToolSchemas,
            ToolCallLedger toolCallLedger,
            CancellationToken cancellation,
            RequestResourceRegistry resources,
            String invocationId) {
        this(appName, userId, threadId, runId, parentRunId, sessionId, input, rawToolSchemas,
                toolCallLedger, cancellation, resources, invocationId, List.of(), Map.of());
    }

    /**
     * Reads the bridge context from a Google ADK run configuration.
     *
     * @param runConfig Google ADK run configuration
     * @return typed context when present
     */
    public static Optional<AdkAgUiRunContext> from(RunConfig runConfig) {
        Objects.requireNonNull(runConfig, "runConfig");
        Object value = runConfig.customMetadata().get(RUN_CONFIG_METADATA_KEY);
        return value instanceof AdkAgUiRunContext context
                ? Optional.of(context)
                : Optional.empty();
    }

    /**
     * Reads the bridge context from the current Google ADK invocation.
     *
     * @param context Google ADK read-only context
     * @return typed context when present
     */
    public static Optional<AdkAgUiRunContext> from(ReadonlyContext context) {
        Objects.requireNonNull(context, "context");
        return from(context.invocationContext().runConfig());
    }

    /**
     * Recursively snapshots the official record and its mutable request values.
     *
     * @param source official input
     * @return immutable input copy
     */
    private static RunAgentInput immutableInput(RunAgentInput source) {
        return new RunAgentInput(
                source.threadId(),
                source.runId(),
                immutableValue(source.state()),
                immutableMessages(source.messages()),
                immutableTools(source.tools()),
                source.context() == null ? List.of() : List.copyOf(source.context()),
                immutableValue(source.forwardedProps()),
                source.resume());
    }

    /**
     * Copies messages and assistant tool-call collections.
     *
     * @param source source messages
     * @return immutable message list
     */
    private static List<Message> immutableMessages(List<Message> source) {
        if (source == null) {
            return List.of();
        }
        return source.stream()
                .map(AdkAgUiRunContext::immutableMessage)
                .toList();
    }

    /**
     * Copies mutable fields owned by an official message record.
     *
     * @param source source message
     * @return immutable message snapshot
     */
    private static Message immutableMessage(Message source) {
        if (source instanceof AssistantMessage assistant) {
            return new AssistantMessage(
                    assistant.id(),
                    assistant.content(),
                    assistant.name(),
                    assistant.toolCalls() == null
                            ? null
                            : List.copyOf(assistant.toolCalls()));
        }
        return source;
    }

    /**
     * Copies tools and recursively snapshots their schema fragments.
     *
     * @param source source tools
     * @return immutable tool list
     */
    private static List<Tool> immutableTools(List<Tool> source) {
        if (source == null) {
            return List.of();
        }
        return source.stream()
                .map(AdkAgUiRunContext::immutableTool)
                .toList();
    }

    /**
     * Copies one tool and its parameter collections.
     *
     * @param source source tool
     * @return immutable tool snapshot
     */
    private static Tool immutableTool(Tool source) {
        ToolParameters parameters = source.parameters();
        if (parameters == null) {
            return source;
        }
        Map<String, Object> properties = parameters.properties() == null
                ? Map.of()
                : immutableStringMap(parameters.properties());
        List<String> required = parameters.required() == null
                ? List.of()
                : List.copyOf(parameters.required());
        return new Tool(
                source.name(),
                source.description(),
                new ToolParameters(parameters.type(), properties, required));
    }

    /**
     * Recursively snapshots supported mutable request values.
     *
     * @param source source value
     * @return immutable snapshot
     */
    private static Object immutableValue(Object source) {
        if (source instanceof JsonNode node) {
            return node.deepCopy();
        }
        if (source instanceof Map<?, ?> map) {
            Map<Object, Object> copy = new LinkedHashMap<>();
            map.forEach((key, value) -> copy.put(key, immutableValue(value)));
            return Collections.unmodifiableMap(copy);
        }
        if (source instanceof List<?> list) {
            List<Object> copy = new ArrayList<>(list.size());
            list.forEach(value -> copy.add(immutableValue(value)));
            return Collections.unmodifiableList(copy);
        }
        return source;
    }

    /**
     * Recursively snapshots a string-keyed schema map.
     *
     * @param source source schema map
     * @return immutable schema map
     */
    private static Map<String, Object> immutableStringMap(Map<String, Object> source) {
        Map<String, Object> copy = new LinkedHashMap<>();
        source.forEach((key, value) -> copy.put(key, immutableValue(value)));
        return Collections.unmodifiableMap(copy);
    }
}
