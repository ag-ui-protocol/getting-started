package com.agui.adk.a2ui;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.Callbacks;
import com.google.adk.agents.InvocationContext;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.LoopAgent;
import com.google.adk.agents.ParallelAgent;
import com.google.adk.agents.SequentialAgent;
import com.google.adk.tools.BaseTool;
import com.google.adk.tools.BaseToolset;
import com.google.genai.types.GenerateContentConfig;
import com.google.genai.types.Schema;
import com.agui.adk.tool.AgUiToolset;
import com.agui.community.core.event.Event;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Scheduler;
import io.reactivex.rxjava3.schedulers.Schedulers;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * P0 #6 — per-run agent-tree copy ({@code _shallow_copy_agent_tree}) and recursive toolset swap
 * ({@code _update_agent_tools_recursive}) over real google-adk agent builders (no live LLM).
 */
class AgentTreeOperationsTest {

    /** Minimal BaseTool used to verify tool references are shared across the per-run copy. */
    private static final class ProbeTool extends BaseTool {
        ProbeTool(String name) {
            super(name, "probe");
        }
    }

    private static final class CustomCompositeAgent extends BaseAgent {
        private final String mode;

        private CustomCompositeAgent(Builder builder) {
            super(builder.name, builder.description, builder.agents,
                    builder.beforeAgentCallbacks, builder.afterAgentCallbacks);
            this.mode = builder.mode;
        }

        static Builder builder() {
            return new Builder();
        }

        String mode() {
            return mode;
        }

        @Override
        protected Flowable<com.google.adk.events.Event> runAsyncImpl(InvocationContext context) {
            return Flowable.empty();
        }

        @Override
        protected Flowable<com.google.adk.events.Event> runLiveImpl(InvocationContext context) {
            return Flowable.empty();
        }

        static final class Builder {
            private String name;
            private String description = "";
            private List<? extends BaseAgent> agents = List.of();
            private List<Callbacks.BeforeAgentCallback> beforeAgentCallbacks = List.of();
            private List<Callbacks.AfterAgentCallback> afterAgentCallbacks = List.of();
            private String mode;

            Builder name(String value) { name = value; return this; }
            Builder description(String value) { description = value; return this; }
            Builder agents(List<? extends BaseAgent> value) { agents = value; return this; }
            Builder beforeAgentCallback(Callbacks.BeforeAgentCallback value) {
                beforeAgentCallbacks = List.of(value); return this;
            }
            Builder afterAgentCallback(Callbacks.AfterAgentCallback value) {
                afterAgentCallbacks = List.of(value); return this;
            }
            Builder mode(String value) { mode = value; return this; }
            CustomCompositeAgent build() { return new CustomCompositeAgent(this); }
        }
    }

    @Test
    void shallowCopyReParentsSubAgentsAndPreservesToolRefs() {
        ProbeTool sharedTool = new ProbeTool("probe");

        LlmAgent leaf = LlmAgent.builder().name("leaf").tools(sharedTool).build();
        SequentialAgent seq = SequentialAgent.builder().name("seq").subAgents(List.of(leaf)).build();
        LlmAgent root = LlmAgent.builder().name("root").tools(sharedTool).subAgents(List.of(seq)).build();

        BaseAgent copied = AgentTreeOperations.shallowCopyAgentTree(root);

        assertThat(copied).isNotSameAs(root);
        assertThat(copied.name()).isEqualTo("root");
        assertThat(copied).isInstanceOf(LlmAgent.class);

        LlmAgent copiedRoot = (LlmAgent) copied;
        // Tools are shared by reference (never deep-copied).
        assertThat(copiedRoot.toolsUnion()).containsExactly(sharedTool);

        // The copied sub-tree is new and re-parented to the copied root.
        List<? extends BaseAgent> copiedSubs = copiedRoot.subAgents();
        assertThat(copiedSubs).hasSize(1);
        assertThat(copiedSubs.get(0)).isNotSameAs(seq).isInstanceOf(SequentialAgent.class);
        assertThat(copiedSubs.get(0).parentAgent()).isSameAs(copiedRoot);

        List<? extends BaseAgent> copiedLeafs = copiedSubs.get(0).subAgents();
        assertThat(copiedLeafs.get(0)).isNotSameAs(leaf);
        assertThat(copiedLeafs.get(0).parentAgent()).isSameAs(copiedSubs.get(0));
    }

    @Test
    void shallowCopyPreservesCompleteLlmConfiguration() {
        ProbeTool sharedTool = new ProbeTool("probe");
        GenerateContentConfig generation = GenerateContentConfig.builder().temperature(0.25f).build();
        Schema inputSchema = Schema.builder().type("OBJECT").build();
        Schema outputSchema = Schema.builder().type("STRING").build();
        Executor executor = Runnable::run;
        Callbacks.BeforeAgentCallback beforeAgent = context -> io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.AfterAgentCallback afterAgent = context -> io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.BeforeModelCallback beforeModel = (context, request) -> io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.AfterModelCallback afterModel = (context, response) -> io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.BeforeToolCallback beforeTool = (context, tool, args, toolContext) ->
                io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.AfterToolCallback afterTool = (context, tool, args, toolContext, result) ->
                io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.OnModelErrorCallback onModelError = (context, request, error) ->
                io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.OnToolErrorCallback onToolError = (context, tool, args, toolContext, error) ->
                io.reactivex.rxjava3.core.Maybe.empty();

        LlmAgent original = LlmAgent.builder().name("configured")
                .instruction("local instruction")
                .globalInstruction("global instruction")
                .tools(sharedTool)
                .generateContentConfig(generation)
                .includeContents(LlmAgent.IncludeContents.NONE)
                .planning(true)
                .maxSteps(17)
                .disallowTransferToParent(true)
                .disallowTransferToPeers(true)
                .beforeAgentCallback(beforeAgent)
                .afterAgentCallback(afterAgent)
                .beforeModelCallback(beforeModel)
                .afterModelCallback(afterModel)
                .beforeToolCallback(beforeTool)
                .afterToolCallback(afterTool)
                .onModelErrorCallback(onModelError)
                .onToolErrorCallback(onToolError)
                .inputSchema(inputSchema)
                .outputSchema(outputSchema)
                .executor(executor)
                .outputKey("structured-output")
                .build();

        LlmAgent copied = (LlmAgent) AgentTreeOperations.shallowCopyAgentTree(original);

        assertThat(copied.instruction()).isSameAs(original.instruction());
        assertThat(copied.globalInstruction()).isSameAs(original.globalInstruction());
        assertThat(copied.model()).isEqualTo(original.model());
        assertThat(copied.generateContentConfig()).contains(generation);
        assertThat(copied.includeContents()).isEqualTo(LlmAgent.IncludeContents.NONE);
        assertThat(copied.planning()).isTrue();
        assertThat(copied.maxSteps()).contains(17);
        assertThat(copied.disallowTransferToParent()).isTrue();
        assertThat(copied.disallowTransferToPeers()).isTrue();
        assertThat(copied.beforeAgentCallback()).hasSize(1);
        assertThat(copied.beforeAgentCallback().getFirst()).isSameAs(beforeAgent);
        assertThat(copied.afterAgentCallback()).hasSize(1);
        assertThat(copied.afterAgentCallback().getFirst()).isSameAs(afterAgent);
        assertThat(copied.beforeModelCallback()).hasSize(1);
        assertThat(copied.beforeModelCallback().getFirst()).isSameAs(beforeModel);
        assertThat(copied.afterModelCallback()).hasSize(1);
        assertThat(copied.afterModelCallback().getFirst()).isSameAs(afterModel);
        assertThat(copied.beforeToolCallback()).hasSize(1);
        assertThat(copied.beforeToolCallback().getFirst()).isSameAs(beforeTool);
        assertThat(copied.afterToolCallback()).hasSize(1);
        assertThat(copied.afterToolCallback().getFirst()).isSameAs(afterTool);
        assertThat(copied.onModelErrorCallback()).hasSize(1);
        assertThat(copied.onModelErrorCallback().getFirst()).isSameAs(onModelError);
        assertThat(copied.onToolErrorCallback()).hasSize(1);
        assertThat(copied.onToolErrorCallback().getFirst()).isSameAs(onToolError);
        assertThat(copied.inputSchema()).contains(inputSchema);
        assertThat(copied.outputSchema()).contains(outputSchema);
        assertThat(copied.executor()).contains(executor);
        assertThat(copied.outputKey()).contains("structured-output");
    }

    @Test
    void updateAgentToolsRecursiveSwapsPlaceholdersAcrossSubAgents() {
        A2UISubAgentTool a2uiRoot = a2uiTool();
        AgUiToolset aguiRoot = new AgUiToolset();
        A2UISubAgentTool a2uiLeaf = a2uiTool();
        LlmAgent leaf = LlmAgent.builder().name("leaf").tools(a2uiLeaf).build();
        SequentialAgent seq = SequentialAgent.builder().name("seq").subAgents(List.of(leaf)).build();
        AgUiToolset aguiLoop = new AgUiToolset();
        LlmAgent loopLeaf = LlmAgent.builder().name("loop-leaf").tools(aguiLoop).build();
        LoopAgent loop = LoopAgent.builder().name("loop").subAgents(List.of(loopLeaf)).build();
        LlmAgent root = LlmAgent.builder().name("root").tools(a2uiRoot, aguiRoot)
                .subAgents(List.of(seq, loop)).build();

        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        BaseToolset proxyMarker = mock(BaseToolset.class);
        Function<Object, Object> agUiMapper = placeholder -> proxyMarker;

        BaseAgent copied = AgentTreeOperations.updateAgentToolsRecursive(root, agUiMapper, queue);

        assertThat(copied).isNotSameAs(root);
        assertThat(copied).isInstanceOf(LlmAgent.class);
        LlmAgent copiedRoot = (LlmAgent) copied;

        // Root union: the A2UI tool is a per-run clone (not the shared construction-time instance)
        // bound to this run's queue, and the AgUiToolset placeholder was swapped for the mapper output.
        Object copiedA2ui = firstOfType(copiedRoot.toolsUnion(), A2UISubAgentTool.class);
        assertThat(copiedA2ui).isNotSameAs(a2uiRoot);
        assertThat(((A2UISubAgentTool) copiedA2ui).eventQueue()).isSameAs(queue);
        assertThat(copiedRoot.toolsUnion()).contains(proxyMarker);
        assertThat(copiedRoot.toolsUnion()).doesNotContain(a2uiRoot, aguiRoot);

        // The SequentialAgent sub-tree carried the swap into its LlmAgent leaf.
        Object copiedLeafA2ui = firstOfType(copiedRoot.subAgents().get(0).subAgents().get(0)
                instanceof LlmAgent la ? la.toolsUnion() : List.of(), A2UISubAgentTool.class);
        assertThat(copiedLeafA2ui).isNotSameAs(a2uiLeaf);
        assertThat(((A2UISubAgentTool) copiedLeafA2ui).eventQueue()).isSameAs(queue);

        // The LoopAgent sub-tree carried the swap into its LlmAgent leaf (AgUiToolset -> marker).
        assertThat(((LlmAgent) copiedRoot.subAgents().get(1).subAgents().get(0)).toolsUnion())
                .containsExactly(proxyMarker);
    }

    @Test
    void parallelAgentNestedA2uiToolIsDetectedAndBoundPerRun() {
        A2UISubAgentTool originalTool = a2uiTool();
        LlmAgent leaf = LlmAgent.builder().name("parallel-leaf").tools(originalTool).build();
        ParallelAgent parallel = ParallelAgent.builder().name("parallel").subAgents(List.of(leaf)).build();

        assertThat(A2uiRunWiring.containsA2uiTool(parallel)).isTrue();

        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        ParallelAgent copied = (ParallelAgent) AgentTreeOperations.updateAgentToolsRecursive(
                parallel, Function.identity(), queue);
        A2UISubAgentTool copiedTool = (A2UISubAgentTool) firstOfType(
                ((LlmAgent) copied.subAgents().getFirst()).toolsUnion(), A2UISubAgentTool.class);

        assertThat(copied).isNotSameAs(parallel);
        assertThat(copied.subAgents().getFirst()).isNotSameAs(leaf);
        assertThat(copiedTool).isNotSameAs(originalTool);
        assertThat(copiedTool.eventQueue()).isSameAs(queue);
    }

    @Test
    void parallelAgentPreservesSchedulerConfiguration() throws Exception {
        Scheduler scheduler = Schedulers.trampoline();
        LlmAgent leaf = LlmAgent.builder().name("scheduler-leaf").build();
        ParallelAgent parallel = ParallelAgent.builder().name("parallel")
                .scheduler(scheduler).subAgents(List.of(leaf)).build();

        ParallelAgent copied = (ParallelAgent) AgentTreeOperations.shallowCopyAgentTree(parallel);
        Field schedulerField = ParallelAgent.class.getDeclaredField("scheduler");
        schedulerField.setAccessible(true);

        assertThat(schedulerField.get(copied)).isSameAs(scheduler);
    }

    @Test
    void customCompositeIsRebuiltWithSubstitutedChildrenAndConfiguration() {
        A2UISubAgentTool originalTool = a2uiTool();
        LlmAgent leaf = LlmAgent.builder().name("custom-leaf").tools(originalTool).build();
        CustomCompositeAgent custom = CustomCompositeAgent.builder().name("custom")
                .description("custom composite").mode("fan-out").agents(List.of(leaf)).build();
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();

        CustomCompositeAgent copied = (CustomCompositeAgent) AgentTreeOperations.updateAgentToolsRecursive(
                custom, Function.identity(), queue);

        assertThat(copied).isNotSameAs(custom);
        assertThat(copied.mode()).isEqualTo("fan-out");
        assertThat(copied.description()).isEqualTo("custom composite");
        assertThat(copied.subAgents().getFirst()).isNotSameAs(leaf);
        A2UISubAgentTool copiedTool = (A2UISubAgentTool) firstOfType(
                ((LlmAgent) copied.subAgents().getFirst()).toolsUnion(), A2UISubAgentTool.class);
        assertThat(copiedTool.eventQueue()).isSameAs(queue);
    }

    @Test
    void compositeRebuildPreservesBaseCallbacks() {
        Callbacks.BeforeAgentCallback before = context -> io.reactivex.rxjava3.core.Maybe.empty();
        Callbacks.AfterAgentCallback after = context -> io.reactivex.rxjava3.core.Maybe.empty();
        LlmAgent leaf = LlmAgent.builder().name("callback-leaf").build();
        LoopAgent loop = LoopAgent.builder().name("loop").subAgents(List.of(leaf))
                .beforeAgentCallback(before).afterAgentCallback(after).build();
        SequentialAgent sequential = SequentialAgent.builder().name("sequential").subAgents(List.of(loop))
                .beforeAgentCallback(before).afterAgentCallback(after).build();
        ParallelAgent parallel = ParallelAgent.builder().name("parallel").subAgents(List.of(sequential))
                .beforeAgentCallback(before).afterAgentCallback(after).build();

        ParallelAgent copied = (ParallelAgent) AgentTreeOperations.shallowCopyAgentTree(parallel);
        SequentialAgent copiedSequential = (SequentialAgent) copied.subAgents().getFirst();
        LoopAgent copiedLoop = (LoopAgent) copiedSequential.subAgents().getFirst();

        for (BaseAgent composite : List.of(copied, copiedSequential, copiedLoop)) {
            assertThat(composite.beforeAgentCallback()).hasSize(1);
            assertThat(composite.beforeAgentCallback().getFirst()).isSameAs(before);
            assertThat(composite.afterAgentCallback()).hasSize(1);
            assertThat(composite.afterAgentCallback().getFirst()).isSameAs(after);
        }
    }

    private static A2UISubAgentTool a2uiTool() {
        return new A2UISubAgentTool("generate_a2ui", "d", null, null, null, null, null, null, null);
    }

    private static Object firstOfType(List<Object> tools, Class<?> type) {
        for (Object tool : tools) {
            if (type.isInstance(tool)) {
                return tool;
            }
        }
        throw new AssertionError("no tool of type " + type.getSimpleName() + " in " + tools);
    }
}
