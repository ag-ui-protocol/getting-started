package com.agui.adk.a2ui;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.RunConfig;
import com.google.adk.models.BaseLlm;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.input.RawToolSchema;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.tool.Tool;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.function.Function;

/**
 * Per-run A2UI wiring for the public run path (port of the Python {@code ADKAgent} run-time glue
 * in {@code adk_agent.py}): plans auto-injection of {@code generate_a2ui} from the forwarded
 * {@code injectA2UITool} flag / backend config, rebuilds the agent tree so every
 * {@link A2UISubAgentTool} (dev-wired or injected) is a per-run {@code forRun} clone bound to this
 * run's nested-tool-call queue, drops the injected render proxy from the frontend tools, and
 * returns the per-run agent tree + run config + queue for the runner call.
 *
 * <p>No-op (returns {@code null}) when the run cannot or must not be rewired: no root agent is
 * exposed, no injection was requested/planned, and the tree carries no dev-wired A2UI tool — so
 * ordinary runs keep using the construction-time runner unchanged.
 */
public final class A2uiRunWiring {

    /** Result of per-run A2UI preparation. */
    public record Result(AdkAgUiRunContext context, RunConfig runConfig, BaseAgent perRunAgent,
                         BlockingQueue<Event> eventQueue, Map<String, Object> plan) {
    }

    private A2uiRunWiring() {
    }

    /**
     * Prepares the per-run A2UI wiring for one execution, or returns {@code null} when no A2UI
     * wiring applies.
     *
     * @param context          the run context (input, forwarded props, request context)
     * @param a2uiConfig       the bridge's A2UI backend config (may be null)
     * @param rootAgent        the runner's root agent, or null when unavailable
     * @param requestRunConfig the request run config (copied when the frontend tool list changes)
     * @return the per-run wiring result, or {@code null}
     */
    public static Result prepare(AdkAgUiRunContext context, Map<String, Object> a2uiConfig,
                                 BaseAgent rootAgent, RunConfig requestRunConfig) {
        if (context == null || rootAgent == null) {
            return null;
        }
        Map<String, Object> config = a2uiConfig == null ? Map.of() : a2uiConfig;

        List<Map<String, String>> contextEntries = new ArrayList<>();
        for (Context entry : context.requestContext()) {
            contextEntries.add(Map.of("description", entry.description(), "value", entry.value()));
        }

        Object flag = context.forwardedProperties().get("injectA2UITool");
        if (flag == null) {
            flag = config.get("inject_a2ui_tool");
        }

        A2uiOperations.A2uiInjectionPlan plan = null;
        if (truthy(flag)) {
            BaseLlm model = rootModel(rootAgent).orElse(null);
            List<String> existingToolNames = existingToolNames(rootAgent);
            plan = A2uiOperations.planA2uiInjection(
                    context.forwardedProperties(), config, existingToolNames, model, contextEntries);
        }

        boolean hasWiredA2ui = containsA2uiTool(rootAgent);
        boolean inject = plan != null && plan.inject();
        if (!inject && !hasWiredA2ui) {
            return null;
        }

        BlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        BaseAgent perRunAgent = AgentTreeOperations.updateAgentToolsRecursive(
                rootAgent, Function.identity(), queue);
        if (inject) {
            BaseLlm model = rootModel(rootAgent).orElse(null);
            if (model == null) {
                // plan.inject() guarantees a model was resolved; defensive guard keeps the run safe.
                return null;
            }
            A2UISubAgentTool injected = new A2UISubAgentTool(
                    plan.toolName(),
                    "Generate or update a dynamic A2UI surface based on the conversation.",
                    model,
                    guidelines(config),
                    config.get("default_surface_id") == null ? null : String.valueOf(config.get("default_surface_id")),
                    config.get("default_catalog_id") == null ? null : String.valueOf(config.get("default_catalog_id")),
                    plan.catalog(),
                    recovery(config),
                    null);
            perRunAgent = AgentTreeOperations.appendRootTool(
                    perRunAgent, injected.forRun(queue));
        }

        AdkAgUiRunContext perRunContext = dropFrontendTools(context, plan == null ? List.of() : plan.dropToolNames());
        RunConfig perRunConfig = perRunContext == context || requestRunConfig == null
                ? null : replaceContext(requestRunConfig, perRunContext);
        return new Result(perRunContext, perRunConfig, perRunAgent, queue,
                inject ? Map.of("tool_name", plan.toolName(), "drop_tool_names", plan.dropToolNames()) : Map.of());
    }

    /**
     * @param config the bridge A2UI backend config
     * @return the A2UI guidelines bag from config (may be null)
     */
    static Map<String, Object> guidelines(Map<String, Object> config) {
        Object value = config.get("guidelines");
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            map.forEach((k, v) -> out.put(String.valueOf(k), v));
            return out;
        }
        return null;
    }

    /**
     * @param config the bridge A2UI backend config
     * @return the recovery config bag from config (may be null)
     */
    static Map<String, Object> recovery(Map<String, Object> config) {
        Object value = config.get("recovery");
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            map.forEach((k, v) -> out.put(String.valueOf(k), v));
            return out;
        }
        return null;
    }

    /**
     * Resolves the root agent's framework model (Python {@code adk_agent.canonical_model}).
     *
     * @param root the root agent
     * @return the resolved {@link BaseLlm}, or empty
     */
    private static Optional<BaseLlm> rootModel(BaseAgent root) {
        if (root instanceof LlmAgent llm) {
            try {
                return llm.resolvedModel().model();
            } catch (RuntimeException e) {
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    /**
     * Collects the tool names on the root LlmAgent (Python's {@code existing_tool_names}).
     *
     * @param root the root agent
     * @return the tool names
     */
    private static List<String> existingToolNames(BaseAgent root) {
        List<String> names = new ArrayList<>();
        if (root instanceof LlmAgent llm) {
            for (Object tool : llm.toolsUnion() == null ? List.of() : llm.toolsUnion()) {
                if (tool instanceof com.google.adk.tools.BaseTool base) {
                    names.add(base.name());
                }
            }
        }
        return names;
    }

    /**
     * Whether the agent tree carries an {@link A2UISubAgentTool} anywhere (dev-wired).
     *
     * @param root the root agent
     * @return true when an A2UI tool is wired on the tree
     */
    static boolean containsA2uiTool(BaseAgent root) {
        if (root instanceof LlmAgent llm) {
            for (Object tool : llm.toolsUnion() == null ? List.of() : llm.toolsUnion()) {
                if (tool instanceof A2UISubAgentTool) {
                    return true;
                }
            }
        }
        List<? extends BaseAgent> subAgents = root.subAgents();
        if (subAgents != null) {
            for (BaseAgent sub : subAgents) {
                if (containsA2uiTool(sub)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Rebuilds the run context with the injected render proxies dropped from the frontend tool
     * list (and the raw schemas renumbered to match), mirroring Python's
     * {@code frontend_tools = [t for t in input.tools if t.name not in drop]}.
     *
     * @param context the original run context
     * @param dropToolNames the frontend render proxies to drop
     * @return the filtered context, or {@code context} when nothing is dropped
     */
    private static AdkAgUiRunContext dropFrontendTools(AdkAgUiRunContext context, List<String> dropToolNames) {
        if (dropToolNames == null || dropToolNames.isEmpty()) {
            return context;
        }
        Set<String> drop = new LinkedHashSet<>(dropToolNames);
        List<Tool> tools = context.input().tools() == null ? List.of() : context.input().tools();
        List<Tool> kept = new ArrayList<>();
        for (Tool tool : tools) {
            if (!drop.contains(tool.name())) {
                kept.add(tool);
            }
        }
        if (kept.size() == tools.size()) {
            return context;
        }
        List<RawToolSchema> keptSchemas = new ArrayList<>();
        int position = 0;
        for (RawToolSchema schema : context.rawToolSchemas()) {
            if (!drop.contains(schema.name())) {
                keptSchemas.add(new RawToolSchema(position, schema.name(), schema.schema()));
                position++;
            }
        }
        RunAgentInput input = context.input();
        RunAgentInput filtered = new RunAgentInput(
                input.threadId(), input.runId(), input.state(), input.messages(), kept,
                input.context(), input.forwardedProps(), input.resume());
        return new AdkAgUiRunContext(
                context.appName(), context.userId(), context.threadId(), context.runId(),
                context.parentRunId(), context.sessionId(), filtered, keptSchemas,
                context.toolCallLedger(), context.cancellation(), context.resources(),
                context.invocationId(), context.requestContext(), context.forwardedProperties());
    }

    /**
     * Rebuilds a RunConfig whose metadata carries the per-run context.
     *
     * @param baseConfig    the request run config to copy
     * @param perRunContext the filtered context to publish under the reserved metadata key
     * @return the copied RunConfig
     */
    private static RunConfig replaceContext(RunConfig baseConfig, AdkAgUiRunContext perRunContext) {
        Map<String, Object> metadata = new LinkedHashMap<>(baseConfig.customMetadata());
        metadata.put(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, perRunContext);
        return baseConfig.toBuilder().customMetadata(metadata).build();
    }

    /**
     * Python truthiness for the injection flag.
     *
     * @param value the flag value
     * @return whether the flag is truthy
     */
    private static boolean truthy(Object value) {
        if (value == null) {
            return false;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        if (value instanceof String s) {
            return !s.isEmpty();
        }
        if (value instanceof Number n) {
            return n.doubleValue() != 0;
        }
        if (value instanceof Iterable<?> || value instanceof Map<?, ?>) {
            return !(value instanceof Iterable<?> it ? !it.iterator().hasNext()
                    : ((Map<?, ?>) value).isEmpty());
        }
        return true;
    }
}
