package com.agui.adk.context;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.InvocationContext;
import com.google.adk.agents.ReadonlyContext;
import com.google.adk.agents.RunConfig;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RawToolSchema;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Proves request context, parent run ID, forwarded properties and raw tool-schema extensions are
 * consumed from the real Google ADK request/run context and surfaced on the Java run context.
 */
class AdkRunExtensionsRuntimeTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final RunContextFactory factory =
            new RunContextFactory("test-app", "user-1", "session-1");

    @Test
    void surfacesContextParentRunIdForwardedPropsAndRawSchemasFromTheAdkRunConfig() {
        RunAgentInput input = input(
                List.of(new Context("tenant", "example"), new Context("region", "eu")),
                Map.of("feature", "on", "nested", Map.of("k", "v")));
        AdkRunExtensions extensions = new AdkRunExtensions(
                "parent-1",
                List.of(new RawToolSchema(0, "show_sports_list", mapper.createObjectNode())));
        RunAgentInput attached = RunExtensionSupport.attach(input, extensions);

        RunConfig adkRunConfig = factory.createRequestConfig(
                RunConfig.builder().build(), attached);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(adkRunConfig).orElseThrow();

        assertThat(context.requestContext())
                .containsExactly(new Context("tenant", "example"), new Context("region", "eu"));
        assertThat(context.parentRunId()).isEqualTo("parent-1");
        assertThat(context.forwardedProperties())
                .containsEntry("feature", "on")
                .containsEntry("nested", Map.of("k", "v"))
                .doesNotContainKey(AdkRunExtensions.FORWARDED_PROPS_KEY);
        assertThat(context.rawToolSchemas())
                .singleElement()
                .satisfies(schema -> {
                    assertThat(schema.position()).isEqualTo(0);
                    assertThat(schema.name()).isEqualTo("show_sports_list");
                });
    }

    @Test
    void resolvesTheSameContextFromTheRealAdkReadonlyContextChain() {
        RunAgentInput input = input(
                List.of(new Context("tenant", "example")),
                Map.of("feature", "on"));
        AdkRunExtensions extensions = new AdkRunExtensions(
                "parent-1",
                List.of(new RawToolSchema(0, "show_sports_list", mapper.createObjectNode())));

        RunConfig adkRunConfig = factory.createRequestConfig(
                RunConfig.builder().build(),
                RunExtensionSupport.attach(input, extensions));

        // The real Google ADK runtime exposes the run configuration through the ReadonlyContext ->
        // InvocationContext -> RunConfig chain that ADK components receive per invocation.
        InvocationContext invocationContext = mock(InvocationContext.class);
        when(invocationContext.runConfig()).thenReturn(adkRunConfig);
        ReadonlyContext readonlyContext = mock(ReadonlyContext.class);
        when(readonlyContext.invocationContext()).thenReturn(invocationContext);

        AdkAgUiRunContext context = AdkAgUiRunContext.from(readonlyContext).orElseThrow();

        assertThat(context.appName()).isEqualTo("test-app");
        assertThat(context.threadId()).isEqualTo("thread-1");
        assertThat(context.requestContext())
                .containsExactly(new Context("tenant", "example"));
        assertThat(context.parentRunId()).isEqualTo("parent-1");
        assertThat(context.forwardedProperties()).containsEntry("feature", "on");
        assertThat(context.rawToolSchemas()).hasSize(1);
        assertThat(context.invocationId()).isNotBlank();
    }

    @Test
    void surfacesNonReservedForwardedPropsAndContextWithoutAnyExtensions() {
        RunAgentInput plain = input(
                List.of(new Context("region", "eu")),
                Map.of("feature", "on"));

        RunConfig adkRunConfig = factory.createRequestConfig(RunConfig.builder().build(), plain);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(adkRunConfig).orElseThrow();

        assertThat(context.requestContext()).containsExactly(new Context("region", "eu"));
        assertThat(context.parentRunId()).isNull();
        assertThat(context.forwardedProperties()).containsEntry("feature", "on");
        assertThat(context.rawToolSchemas()).singleElement().satisfies(rawSchema -> {
            assertThat(rawSchema.position()).isZero();
            assertThat(rawSchema.name()).isEqualTo("show_sports_list");
            assertThat(rawSchema.schema().get("type").asText()).isEqualTo("object");
        });
    }

    private static RunAgentInput input(List<Context> contexts, Map<String, Object> forwardedProps) {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of("status", "active"),
                List.of(new UserMessage("message-1", "hello")),
                List.of(new Tool(
                        "show_sports_list",
                        "Shows sports",
                        new ToolParameters(Map.of(), List.of()))),
                contexts,
                new LinkedHashMap<>(forwardedProps));
    }
}
