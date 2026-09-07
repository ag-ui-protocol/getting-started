package com.agui.adk.a2ui;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.LoopAgent;
import com.google.adk.agents.ParallelAgent;
import com.google.adk.agents.SequentialAgent;
import com.agui.adk.tool.AgUiToolset;
import com.agui.community.core.event.Event;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.function.Function;

/**
 * Per-run agent-tree operations (port of {@code ADKAgent._shallow_copy_agent_tree} and
 * {@code ADKAgent._update_agent_tools_recursive} from {@code adk_agent.py}).
 *
 * <p>ADK Java agents are immutable value objects, so the Python "shallow copy then mutate in place"
 * strategy becomes a <em>rebuild</em>: each agent and its sub-agents are reconstructed into new
 * instances (so a later parent rebuild never steals a sub-agent's {@code parentAgent} — the runtime
 * re-parents automatically on build), while tool object references are <em>shared</em> (never
 * deep-copied, keeping non-copyable tools such as ADK {@code McpToolset} safe).
 *
 * <p>{@link #shallowCopyAgentTree} is the pure per-run copy. {@link #updateAgentToolsRecursive}
 * additionally walks every {@link LlmAgent} (including inside {@link SequentialAgent}/{@link LoopAgent}
 * sub-trees) and, per tool in its union, swaps an {@link A2UISubAgentTool} for its per-run
 * {@code forRun} clone and an {@link AgUiToolset} placeholder for the per-run toolset produced by the
 * injected mapper. Because ADK's Java {@code AgUiToolset} is stateless (it reads request metadata at
 * invocation time, unlike the Python {@code ClientProxyToolset}), the per-run toolset creation is a
 * caller-supplied {@link Function} seam rather than a magic constant.
 */
public final class AgentTreeOperations {

    private AgentTreeOperations() {
    }

    /**
     * Shallow-copies an agent and its sub-agent tree (Python {@code _shallow_copy_agent_tree}). New
     * agent instances are created for every node so per-execution field reassignment never mutates the
     * originals; tool objects are shared by reference; composite (Sequential/Loop) and recursive
     * sub-agents are re-parented to the copied parent by their builders.
     *
     * @param agent the root agent to copy
     * @return a fresh tree sharing tool references, or {@code agent} when it is not a rebuildable type
     */
    public static BaseAgent shallowCopyAgentTree(BaseAgent agent) {
        return rebuild(agent, Function.identity());
    }

    /**
     * Recursively swaps per-run tools across an agent tree (Python {@code _update_agent_tools_recursive}).
     * Every {@link LlmAgent}'s tool union is mapped with {@link #swapAgentTool} (so an
     * {@link A2UISubAgentTool} becomes its per-run {@code forRun} clone and an {@link AgUiToolset}
     * placeholder becomes the per-run toolset from {@code agUiToolsetMapper}), walking
     * {@link SequentialAgent}/{@link LoopAgent} sub-agents as well. Returns a rebuilt tree (agents are
     * immutable).
     *
     * @param root              the per-run agent tree to process
     * @param agUiToolsetMapper per-run {@code ClientProxyToolset}-equivalent factory for an
     *                          {@link AgUiToolset} placeholder (may be {@code Function.identity()})
     * @param eventQueue        the run's nested tool-call event queue bound to {@link A2UISubAgentTool} clones
     * @return the rebuilt tree with per-run tools swapped
     */
    public static BaseAgent updateAgentToolsRecursive(BaseAgent root,
                                                      Function<Object, Object> agUiToolsetMapper,
                                                      BlockingQueue<Event> eventQueue) {
        return rebuild(root, tool -> swapAgentTool(tool, agUiToolsetMapper, eventQueue));
    }

    /**
     * Maps one tool in an {@link LlmAgent} union to its per-run replacement: an
     * {@link A2UISubAgentTool} becomes its {@code forRun} clone bound to {@code eventQueue}, an
     * {@link AgUiToolset} placeholder becomes the mapper-supplied per-run toolset, and any other tool is
     * kept as-is (shared reference).
     *
     * @param tool              the tool or toolset to map
     * @param agUiToolsetMapper per-run {@code ClientProxyToolset}-equivalent factory (may be
     *                          {@code Function.identity()})
     * @param eventQueue        the run's nested tool-call event queue
     * @return the per-run replacement, or the original tool
     */
    public static Object swapAgentTool(Object tool, Function<Object, Object> agUiToolsetMapper,
                                       BlockingQueue<Event> eventQueue) {
        if (tool instanceof A2UISubAgentTool subAgentTool) {
            return subAgentTool.forRun(eventQueue);
        }
        if (tool instanceof AgUiToolset placeholder) {
            Function<Object, Object> mapper = agUiToolsetMapper == null ? Function.identity() : agUiToolsetMapper;
            return mapper.apply(placeholder);
        }
        return tool;
    }

    /**
     * Rebuilds the agent tree into new instances, mapping each {@link LlmAgent} tool union through
     * {@code toolMapper} and recursively rebuilding sub-agents (new instances, auto re-parented).
     *
     * @param agent      the agent to rebuild
     * @param toolMapper maps each tool in an {@link LlmAgent} union to its replacement
     * @return the rebuilt agent, or {@code agent} unchanged when it is not a rebuildable type
     */
    private static BaseAgent rebuild(BaseAgent agent, Function<Object, Object> toolMapper) {
        List<? extends BaseAgent> subAgents = agent.subAgents();
        List<BaseAgent> copied = new ArrayList<>();
        if (subAgents != null) {
            for (BaseAgent sub : subAgents) {
                copied.add(rebuild(sub, toolMapper));
            }
        }

        if (agent instanceof LlmAgent llm) {
            return rebuildLlmAgent(llm, copied, toolMapper);
        }
        if (agent instanceof LoopAgent loop) {
            LoopAgent.Builder builder = LoopAgent.builder().name(agent.name()).description(agent.description());
            if (loop.maxIterations() != null) {
                builder.maxIterations(loop.maxIterations());
            }
            carryBaseConfig(agent, builder);
            return builder.subAgents(copied).build();
        }
        if (agent instanceof SequentialAgent) {
            SequentialAgent.Builder builder = SequentialAgent.builder()
                    .name(agent.name()).description(agent.description());
            carryBaseConfig(agent, builder);
            return builder.subAgents(copied).build();
        }
        if (agent instanceof ParallelAgent) {
            return rebuildGenericComposite(agent, copied);
        }
        if (subAgents != null && !subAgents.isEmpty()) {
            return rebuildGenericComposite(agent, copied);
        }
        return agent;
    }

    /**
     * Rebuilds an {@link LlmAgent} into a new instance, mapping its tool union and wiring freshly copied
     * sub-agents (auto re-parented by the builder); shares instruction and model references.
     *
     * @param llm        the agent to copy
     * @param copied     the freshly copied, re-parentable sub-agents
     * @param toolMapper maps each tool in the union to its replacement
     * @return the rebuilt agent
     */
    private static BaseAgent rebuildLlmAgent(LlmAgent llm, List<BaseAgent> copied,
                                             Function<Object, Object> toolMapper) {
        LlmAgent.Builder builder = LlmAgent.builder().name(llm.name()).description(llm.description());

        List<Object> union = llm.toolsUnion();
        if (union != null && !union.isEmpty()) {
            List<Object> mapped = new ArrayList<>();
            for (Object tool : union) {
                mapped.add(toolMapper.apply(tool));
            }
            builder.tools(mapped);
        }
        if (!copied.isEmpty()) {
            builder.subAgents(copied);
        }
        carryLlmConfig(llm, builder);
        return builder.build();
    }

    /**
     * Appends a per-run tool onto an already-rebuilt root {@link LlmAgent} (A2UI auto-injection:
     * the injected {@code generate_a2ui} tool rides on the root planning agent only, mirroring the
     * Strands adapter's single-agent injection). Sub-agents are the caller's per-run copies and are
     * carried by reference (they are already new instances).
     *
     * @param root the per-run root agent
     * @param tool the per-run tool to append (already bound via {@code forRun})
     * @return the rebuilt root with the tool appended, or {@code root} when it is not an LlmAgent
     */
    public static BaseAgent appendRootTool(BaseAgent root, Object tool) {
        if (!(root instanceof LlmAgent llm)) {
            return root;
        }
        List<Object> union = new ArrayList<>();
        if (llm.toolsUnion() != null) {
            union.addAll(llm.toolsUnion());
        }
        union.add(tool);
        List<BaseAgent> copied = new ArrayList<>();
        if (llm.subAgents() != null) {
            copied.addAll(llm.subAgents());
        }
        LlmAgent.Builder builder = LlmAgent.builder().name(llm.name()).description(llm.description())
                .tools(union);
        if (!copied.isEmpty()) {
            builder.subAgents(copied);
        }
        carryLlmConfig(llm, builder);
        return builder.build();
    }

    /**
     * Copies callbacks common to every ADK agent.
     *
     * @param agent source agent
     * @param builder destination builder
     */
    private static void carryBaseConfig(BaseAgent agent, BaseAgent.Builder<?> builder) {
        agent.beforeAgentCallback().forEach(builder::beforeAgentCallback);
        agent.afterAgentCallback().forEach(builder::afterAgentCallback);
    }

    /**
     * Rebuilds any composite following ADK's builder contract. The builder is populated from
     * same-named zero-argument accessors (or, for immutable implementation details such as
     * {@link ParallelAgent}'s scheduler, same-named fields), then the recursively rebuilt children
     * and base callbacks replace the copied values.
     *
     * @param agent source composite
     * @param copied recursively rebuilt children
     * @return rebuilt composite
     */
    private static BaseAgent rebuildGenericComposite(BaseAgent agent, List<BaseAgent> copied) {
        try {
            Method builderFactory = agent.getClass().getDeclaredMethod("builder");
            builderFactory.setAccessible(true);
            Object builder = builderFactory.invoke(null);

            invokeBuilder(builder, "name", agent.name());
            invokeBuilder(builder, "description", agent.description());
            copyCompositeProperties(agent, builder);
            invokeChildrenBuilder(builder, copied);
            for (Object callback : agent.beforeAgentCallback()) {
                invokeBuilder(builder, "beforeAgentCallback", callback);
            }
            for (Object callback : agent.afterAgentCallback()) {
                invokeBuilder(builder, "afterAgentCallback", callback);
            }
            Method build = findMethod(builder.getClass(), "build", 0);
            return (BaseAgent) build.invoke(builder);
        } catch (ReflectiveOperationException e) {
            throw new IllegalArgumentException(
                    "Composite agent " + agent.getClass().getName()
                            + " must expose a builder() contract to substitute rebuilt children", e);
        }
    }

    /**
     * Copies builder-specific shallow configuration by matching property names.
     * @param agent source composite
     * @param builder destination builder
     */
    private static void copyCompositeProperties(BaseAgent agent, Object builder)
            throws ReflectiveOperationException {
        for (Class<?> type = builder.getClass(); type != null; type = type.getSuperclass()) {
            for (Method setter : type.getDeclaredMethods()) {
                String name = setter.getName();
                if (setter.getParameterCount() != 1 || Modifier.isStatic(setter.getModifiers())
                        || setter.isBridge() || setter.isSynthetic()
                        || setter.getReturnType().equals(void.class)
                        || name.equals("name") || name.equals("description") || name.equals("subAgents")
                        || name.equals("beforeAgentCallback") || name.equals("afterAgentCallback")) {
                    continue;
                }
                Object value = readProperty(agent, name);
                if (value != MissingValue.INSTANCE) {
                    setter.setAccessible(true);
                    setter.invoke(builder, value);
                }
            }
        }
    }

    /**
     * Reads a same-named accessor or immutable field.
     * @param agent source composite
     * @param name property name
     * @return property value or a missing-value sentinel
     */
    private static Object readProperty(BaseAgent agent, String name) throws ReflectiveOperationException {
        try {
            Method getter = agent.getClass().getMethod(name);
            if (getter.getParameterCount() == 0) {
                return getter.invoke(agent);
            }
        } catch (NoSuchMethodException ignored) {
            // Some ADK configuration is intentionally implementation-private; copy its field below.
        }
        Class<?> type = agent.getClass();
        while (type != null && type != BaseAgent.class) {
            try {
                Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(agent);
            } catch (NoSuchFieldException ignored) {
                type = type.getSuperclass();
            }
        }
        return MissingValue.INSTANCE;
    }

    /**
     * Replaces recursively copied children through the composite builder's duck-typed contract.
     * @param builder destination builder
     * @param copied recursively rebuilt children
     */
    private static void invokeChildrenBuilder(Object builder, List<BaseAgent> copied)
            throws ReflectiveOperationException {
        for (String name : List.of("subAgents", "agents", "children")) {
            try {
                invokeBuilder(builder, name, copied);
                return;
            } catch (NoSuchMethodException ignored) {
                // Try the next conventional composite-child setter.
            }
        }
        throw new NoSuchMethodException(builder.getClass().getName() + ".subAgents/agents/children");
    }

    /**
     * Invokes one compatible builder setter.
     * @param builder destination builder
     * @param name setter name
     * @param value property value
     */
    private static void invokeBuilder(Object builder, String name, Object value)
            throws ReflectiveOperationException {
        Method method = findCompatibleMethod(builder.getClass(), name, value);
        method.setAccessible(true);
        method.invoke(builder, value);
    }

    /**
     * Finds a compatible one-argument method across the builder hierarchy.
     * @param type builder type
     * @param name method name
     * @param value argument value
     * @return compatible method
     */
    private static Method findCompatibleMethod(Class<?> type, String name, Object value)
            throws NoSuchMethodException {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getName().equals(name) && method.getParameterCount() == 1
                        && (value == null || method.getParameterTypes()[0].isAssignableFrom(value.getClass()))) {
                    return method;
                }
            }
        }
        throw new NoSuchMethodException(type.getName() + "." + name);
    }

    /**
     * Finds a method by name and arity across the builder hierarchy.
     * @param type builder type
     * @param name method name
     * @param parameterCount method arity
     * @return matching method
     */
    private static Method findMethod(Class<?> type, String name, int parameterCount)
            throws NoSuchMethodException {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getName().equals(name) && method.getParameterCount() == parameterCount) {
                    method.setAccessible(true);
                    return method;
                }
            }
        }
        throw new NoSuchMethodException(type.getName() + "." + name);
    }

    /** Sentinel distinguishing a missing property from a present null value. */
    private enum MissingValue { INSTANCE }

    /**
     * Copies the complete LLM-specific shallow configuration.
     *
     * @param llm source agent
     * @param builder destination builder
     */
    private static void carryLlmConfig(LlmAgent llm, LlmAgent.Builder builder) {
        builder.instruction(llm.instruction());
        builder.globalInstruction(llm.globalInstruction());
        llm.model().ifPresent(model -> {
            if (model.model().isPresent()) {
                builder.model(model.model().orElseThrow());
            } else {
                model.modelName().ifPresent(builder::model);
            }
        });
        builder.planning(llm.planning());
        llm.maxSteps().ifPresent(builder::maxSteps);
        llm.generateContentConfig().ifPresent(builder::generateContentConfig);
        builder.includeContents(llm.includeContents());
        builder.disallowTransferToParent(llm.disallowTransferToParent());
        builder.disallowTransferToPeers(llm.disallowTransferToPeers());

        llm.beforeAgentCallback().forEach(builder::beforeAgentCallback);
        llm.afterAgentCallback().forEach(builder::afterAgentCallback);
        llm.beforeModelCallback().forEach(builder::beforeModelCallback);
        llm.afterModelCallback().forEach(builder::afterModelCallback);
        llm.onModelErrorCallback().forEach(builder::onModelErrorCallback);
        llm.beforeToolCallback().forEach(builder::beforeToolCallback);
        llm.afterToolCallback().forEach(builder::afterToolCallback);
        llm.onToolErrorCallback().forEach(builder::onToolErrorCallback);

        llm.inputSchema().ifPresent(builder::inputSchema);
        llm.outputSchema().ifPresent(builder::outputSchema);
        llm.executor().ifPresent(builder::executor);
        llm.outputKey().ifPresent(builder::outputKey);
        llm.codeExecutor().ifPresent(builder::codeExecutor);
    }

}
