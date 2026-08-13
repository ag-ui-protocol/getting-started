package com.agui.adk.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.InvocationContext;
import com.google.adk.agents.LlmAgent;
import com.google.adk.agents.ReadonlyContext;
import com.google.adk.agents.RunConfig;
import com.google.adk.tools.BaseTool;
import com.google.adk.sessions.InMemorySessionService;
import com.google.adk.sessions.Session;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.context.RequestResourceRegistry;
import com.agui.adk.execution.CancellationToken;
import com.agui.adk.hitl.ToolCallLedger;
import com.agui.adk.input.RawToolSchema;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AgUiToolsetConcurrencyTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void exposesOnlyToolsFromEachConcurrentRequestMetadata() throws Exception {
        AgUiToolset toolset = new AgUiToolset();
        CountDownLatch bothCallsEntered = new CountDownLatch(2);
        CountDownLatch releaseBothCalls = new CountDownLatch(1);
        ReadonlyContext first = contextFor(
                "show_sports_list", bothCallsEntered, releaseBothCalls);
        ReadonlyContext second = contextFor(
                "show_movie_list", bothCallsEntered, releaseBothCalls);
        ExecutorService executor = Executors.newFixedThreadPool(2);

        try {
            Callable<List<String>> firstCall = () -> resolveToolNames(toolset, first);
            Callable<List<String>> secondCall = () -> resolveToolNames(toolset, second);
            Future<List<String>> firstResult = executor.submit(firstCall);
            Future<List<String>> secondResult = executor.submit(secondCall);

            assertThat(bothCallsEntered.await(5, TimeUnit.SECONDS)).isTrue();
            releaseBothCalls.countDown();

            assertThat(firstResult.get()).containsExactly("show_sports_list");
            assertThat(secondResult.get()).containsExactly("show_movie_list");
        } finally {
            releaseBothCalls.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void exposesRequestDefinedToolThroughActualLlmAgentCanonicalResolution() throws Exception {
        LlmAgent agent = LlmAgent.builder()
                .name("tool-root")
                .tools(new AgUiToolset())
                .build();
        ReadonlyContext context = new ReadonlyContext(InvocationContext.builder()
                .agent(agent)
                .sessionService(new InMemorySessionService())
                .session(Session.builder("session").appName("app").userId("user").build())
                .runConfig(contextFor("show_sports_list").invocationContext().runConfig())
                .build());

        assertThat(agent.canonicalTools(context).map(tool -> tool.name()).toList().blockingGet())
                .containsExactly("show_sports_list");
    }

    @Test
    void filtersOriginalNamesBeforePrefixThroughCanonicalResolution() throws Exception {
        LlmAgent agent = LlmAgent.builder()
                .name("tool-root")
                .tools(new AgUiToolset(List.of("show_sports_list"), "frontend"))
                .build();
        ReadonlyContext context = canonicalContext(agent, twoToolContext());

        List<BaseTool> tools = agent.canonicalTools(context).toList().blockingGet();

        assertThat(tools).extracting(BaseTool::name)
                .containsExactly("frontend_show_sports_list");
        assertThat(tools.getFirst().declaration().orElseThrow().name())
                .contains("frontend_show_sports_list");
        assertThat(tools.getFirst().longRunning()).isTrue();
        AdkAgUiRunContext runContext = AdkAgUiRunContext.from(context).orElseThrow();
        assertThat(FrontendToolExposure.from(runContext).names())
                .containsExactly("frontend_show_sports_list");
    }

    @Test
    void aggregatesEffectiveNamesAcrossMultipleToolsets() throws Exception {
        ReadonlyContext context = twoToolContext();

        resolveToolNames(new AgUiToolset(List.of("show_sports_list"), "first"), context);
        resolveToolNames(new AgUiToolset(List.of("show_movie_list"), "second"), context);

        AdkAgUiRunContext runContext = AdkAgUiRunContext.from(context).orElseThrow();
        assertThat(FrontendToolExposure.from(runContext).names())
                .containsExactlyInAnyOrder(
                        "first_show_sports_list",
                        "second_show_movie_list");
    }

    @Test
    void filtersWithContextAwarePredicateThroughCanonicalResolution() throws Exception {
        java.util.concurrent.atomic.AtomicReference<ReadonlyContext> observed =
                new java.util.concurrent.atomic.AtomicReference<>();
        com.google.adk.tools.ToolPredicate predicate = (tool, context) -> {
            observed.set(context.orElseThrow());
            return tool.name().equals("show_movie_list");
        };
        LlmAgent agent = LlmAgent.builder()
                .name("tool-root")
                .tools(new AgUiToolset(predicate, null))
                .build();
        ReadonlyContext context = canonicalContext(agent, twoToolContext());

        assertThat(agent.canonicalTools(context).map(BaseTool::name).toList().blockingGet())
                .containsExactly("show_movie_list");
        assertThat(observed.get()).isSameAs(context);
    }

    @Test
    void ordersRequestToolsByTheirRawSchemaPositions() throws Exception {
        Tool first = new Tool("show_sports_list", "client action", new ToolParameters(Map.of(), List.of()));
        Tool second = new Tool("show_movie_list", "client action", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = new RunAgentInput(
                "thread", "run", Map.of(), List.of(), List.of(first, second), List.of(), Map.of());
        AdkAgUiRunContext requestContext = new AdkAgUiRunContext(
                "app", "user", "thread", "run", null, "session", input,
                List.of(
                        new RawToolSchema(1, "show_movie_list", mapper.readTree("{\"type\":\"object\"}")),
                        new RawToolSchema(0, "show_sports_list", mapper.readTree("{\"type\":\"object\"}"))),
                new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
        RunConfig runConfig = RunConfig.builder()
                .customMetadata(Map.of(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, requestContext))
                .build();
        ReadonlyContext context = mock(ReadonlyContext.class);
        com.google.adk.agents.InvocationContext invocation = mock(com.google.adk.agents.InvocationContext.class);
        when(context.invocationContext()).thenReturn(invocation);
        when(invocation.runConfig()).thenReturn(runConfig);

        assertThat(resolveToolNames(new AgUiToolset(), context))
                .containsExactly("show_sports_list", "show_movie_list");
    }

    @Test
    void skipsOnlyMalformedToolSchemaAndExposesValidSiblingThroughCanonicalResolution() throws Exception {
        Tool malformed = new Tool("malformed_tool", "invalid client action", new ToolParameters(Map.of(), List.of()));
        Tool valid = new Tool("valid_tool", "valid client action", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = new RunAgentInput(
                "thread", "run", Map.of(), List.of(), List.of(malformed, valid), List.of(), Map.of());
        AdkAgUiRunContext requestContext = new AdkAgUiRunContext(
                "app", "user", "thread", "run", null, "session", input,
                List.of(
                        new RawToolSchema(0, "malformed_tool", mapper.readTree(
                                "{\"type\":\"object\",\"properties\":[]}")),
                        new RawToolSchema(1, "valid_tool", mapper.readTree(
                                "{\"type\":\"object\",\"properties\":{}}"))),
                new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
        RunConfig runConfig = RunConfig.builder()
                .customMetadata(Map.of(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, requestContext))
                .build();
        LlmAgent agent = LlmAgent.builder()
                .name("tool-root")
                .tools(new AgUiToolset())
                .build();
        ReadonlyContext context = new ReadonlyContext(InvocationContext.builder()
                .agent(agent)
                .sessionService(new InMemorySessionService())
                .session(Session.builder("session").appName("app").userId("user").build())
                .runConfig(runConfig)
                .build());

        assertThat(agent.canonicalTools(context).map(BaseTool::name).toList().blockingGet())
                .containsExactly("valid_tool");
        assertThat(FrontendToolExposure.from(requestContext).names())
                .containsExactly("valid_tool");
    }

    @Test
    void exposesNonObjectRootAsEmptyObjectSchema() throws Exception {
        Tool tool = new Tool("root_array_tool", "client action", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = new RunAgentInput(
                "thread", "run", Map.of(), List.of(), List.of(tool), List.of(), Map.of());
        AdkAgUiRunContext requestContext = new AdkAgUiRunContext(
                "app", "user", "thread", "run", null, "session", input,
                List.of(new RawToolSchema(0, "root_array_tool", mapper.readTree("[]"))),
                new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
        RunConfig runConfig = RunConfig.builder()
                .customMetadata(Map.of(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, requestContext))
                .build();
        ReadonlyContext context = mock(ReadonlyContext.class);
        InvocationContext invocation = mock(InvocationContext.class);
        when(context.invocationContext()).thenReturn(invocation);
        when(invocation.runConfig()).thenReturn(runConfig);

        List<BaseTool> tools = new AgUiToolset().getTools(context).toList().blockingGet();

        assertThat(tools).extracting(BaseTool::name).containsExactly("root_array_tool");
        assertThat(tools.getFirst().declaration().orElseThrow().parameters().orElseThrow()
                .type().orElseThrow().toString()).isEqualTo("OBJECT");
        assertThat(tools.getFirst().declaration().orElseThrow().parameters().orElseThrow().properties())
                .contains(Map.of());
    }

    @Test
    void rejectsInvocationWithoutRequestMetadata() {
        AgUiToolset toolset = new AgUiToolset();
        ReadonlyContext context = mock(ReadonlyContext.class);
        when(context.invocationContext()).thenReturn(mock(com.google.adk.agents.InvocationContext.class));
        when(context.invocationContext().runConfig()).thenReturn(RunConfig.builder().build());

        assertThatThrownBy(() -> toolset.getTools(context).blockingIterable().iterator().hasNext())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("missing AG-UI run context metadata");
    }

    private ReadonlyContext twoToolContext() throws Exception {
        Tool first = new Tool("show_sports_list", "client action", new ToolParameters(Map.of(), List.of()));
        Tool second = new Tool("show_movie_list", "client action", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = new RunAgentInput(
                "thread", "run", Map.of(), List.of(), List.of(first, second), List.of(), Map.of());
        AdkAgUiRunContext requestContext = new AdkAgUiRunContext(
                "app", "user", "thread", "run", null, "session", input,
                List.of(
                        new RawToolSchema(0, "show_sports_list", mapper.readTree("{\"type\":\"object\"}")),
                        new RawToolSchema(1, "show_movie_list", mapper.readTree("{\"type\":\"object\"}"))),
                new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
        RunConfig runConfig = RunConfig.builder()
                .customMetadata(Map.of(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, requestContext))
                .build();
        ReadonlyContext context = mock(ReadonlyContext.class);
        InvocationContext invocation = mock(InvocationContext.class);
        when(context.invocationContext()).thenReturn(invocation);
        when(invocation.runConfig()).thenReturn(runConfig);
        return context;
    }

    private static ReadonlyContext canonicalContext(LlmAgent agent, ReadonlyContext source) {
        return new ReadonlyContext(InvocationContext.builder()
                .agent(agent)
                .sessionService(new InMemorySessionService())
                .session(Session.builder("session").appName("app").userId("user").build())
                .runConfig(source.invocationContext().runConfig())
                .build());
    }

    private static List<String> resolveToolNames(AgUiToolset toolset, ReadonlyContext context) {
        return toolset.getTools(context).map(tool -> tool.name()).toList().blockingGet();
    }

    private ReadonlyContext contextFor(String toolName) throws Exception {
        return contextFor(toolName, null, null);
    }

    private ReadonlyContext contextFor(
            String toolName,
            CountDownLatch bothCallsEntered,
            CountDownLatch releaseBothCalls) throws Exception {
        Tool tool = new Tool(toolName, "client action", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = new RunAgentInput(
                "thread", "run", Map.of(), List.of(), List.of(tool), List.of(), Map.of());
        AdkAgUiRunContext requestContext = new AdkAgUiRunContext(
                "app", "user", "thread", "run", null, "session", input,
                List.of(new RawToolSchema(0, toolName, mapper.readTree("{\"type\":\"object\"}"))),
                new ToolCallLedger(), new CancellationToken(), RequestResourceRegistry.create(), "invocation");
        RunConfig runConfig = RunConfig.builder()
                .customMetadata(Map.of(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, requestContext))
                .build();
        ReadonlyContext context = mock(ReadonlyContext.class);
        com.google.adk.agents.InvocationContext invocation = mock(com.google.adk.agents.InvocationContext.class);
        if (bothCallsEntered == null) {
            when(context.invocationContext()).thenReturn(invocation);
        } else {
            when(context.invocationContext()).thenAnswer(ignored -> {
                bothCallsEntered.countDown();
                if (!releaseBothCalls.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("concurrent toolset calls did not overlap");
                }
                return invocation;
            });
        }
        when(invocation.runConfig()).thenReturn(runConfig);
        return context;
    }
}
