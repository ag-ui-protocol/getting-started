package com.agui.adk.context;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.google.adk.agents.RunConfig;
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RawToolSchema;
import com.agui.adk.input.RunInputValidator;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.FunctionCall;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RunContextFactoryTest {

    private final RunContextFactory factory =
            new RunContextFactory("test-app", "user-1", "session-1");

    @Test
    void copiesRunConfigPreservesMetadataAndDetachesExtensions() {
        RunConfig base = RunConfig.builder()
                .customMetadata(Map.of("existingPluginKey", "value"))
                .build();
        RunAgentInput input = input(Map.of("tenant", "example"));
        AdkRunExtensions extensions = extensions("show_sports_list", 0);

        RunConfig request = factory.createRequestConfig(base, input, extensions);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(request).orElseThrow();

        assertThat(base.customMetadata())
                .containsEntry("existingPluginKey", "value")
                .doesNotContainKey(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
        assertThat(request).isNotSameAs(base);
        assertThat(request.customMetadata())
                .containsEntry("existingPluginKey", "value")
                .containsEntry(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, context);
        assertThat(input.forwardedProps()).isEqualTo(Map.of("tenant", "example"));
        assertThat(context.input()).isNotSameAs(input);
        assertThat(context.input().forwardedProps()).isEqualTo(Map.of("tenant", "example"));
        assertThat(context.rawToolSchemas()).containsExactlyElementsOf(extensions.rawToolSchemas());
        assertThat(context.parentRunId()).isEqualTo("parent-1");
        assertThat(context.appName()).isEqualTo("test-app");
        assertThat(context.userId()).isEqualTo("user-1");
        assertThat(context.threadId()).isEqualTo("thread-1");
        assertThat(context.runId()).isEqualTo("run-1");
        assertThat(context.sessionId()).isEqualTo("session-1");
        assertThat(context.invocationId()).isNotBlank();
    }

    @Test
    void derivesRawToolSchemasFromStandardToolsWhenExtensionIsAbsent() {
        RunAgentInput input = new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of(),
                List.of(new UserMessage("message-1", "hello")),
                List.of(new Tool(
                        "show_sports_list",
                        "Shows sports",
                        new ToolParameters(
                                Map.of("sports", Map.of(
                                        "type", "array",
                                        "items", Map.of(
                                                "type", "object",
                                                "description", "A sport selection",
                                                "minProperties", 1,
                                                "oneOf", List.of(Map.of("required", List.of("name")))))),
                                List.of("sports")))),
                List.of(),
                Map.of());

        RunConfig request = factory.createRequestConfig(RunConfig.builder().build(), input);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(request).orElseThrow();

        assertThat(context.rawToolSchemas()).singleElement().satisfies(rawSchema -> {
            assertThat(rawSchema.position()).isZero();
            assertThat(rawSchema.name()).isEqualTo("show_sports_list");
            assertThat(rawSchema.schema().get("type").asText()).isEqualTo("object");
            assertThat(rawSchema.schema().get("required").get(0).asText()).isEqualTo("sports");
            JsonNode itemSchema = rawSchema.schema().get("properties").get("sports").get("items");
            assertThat(itemSchema.get("type").asText()).isEqualTo("object");
            assertThat(itemSchema.get("description").asText()).isEqualTo("A sport selection");
            assertThat(itemSchema.get("minProperties").asInt()).isOne();
            assertThat(itemSchema.has("anyOf")).isTrue();
            assertThat(itemSchema.has("oneOf")).isFalse();
        });
    }

    @Test
    void extractsAttachedExtensionsWithoutChangingTheSuppliedInput() {
        RunAgentInput input = input(Map.of("tenant", "example"));
        AdkRunExtensions extensions = extensions("show_sports_list", 0);
        RunAgentInput attached = com.agui.adk.input.RunExtensionSupport
                .attach(input, extensions);

        RunConfig request = factory.createRequestConfig(RunConfig.builder().build(), attached);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(request).orElseThrow();

        assertThat(com.agui.adk.input.RunExtensionSupport.extract(attached))
                .contains(extensions);
        assertThat(com.agui.adk.input.RunExtensionSupport.extract(context.input()))
                .isEmpty();
        assertThat(context.input().forwardedProps()).isEqualTo(Map.of("tenant", "example"));
    }

    @Test
    void rejectsReservedRunConfigMetadataCollision() {
        RunConfig base = RunConfig.builder()
                .customMetadata(Map.of(
                        AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY,
                        "caller-value"))
                .build();

        assertThatThrownBy(() -> factory.createRequestConfig(base, input(Map.of())))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
        assertThat(base.customMetadata())
                .containsEntry(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, "caller-value");
    }

    @Test
    void rejectsNonMapForwardedPropsWithoutNormalizingThem() {
        List<String> forwardedProps = new ArrayList<>(List.of("opaque"));

        assertThatThrownBy(() -> factory.createRequestConfig(
                RunConfig.builder().build(),
                input(forwardedProps)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("forwardedProps");
        assertThat(forwardedProps).containsExactly("opaque");
    }

    @Test
    void rejectsNonStringForwardedPropertyKeysWithoutNormalizingThem() {
        Map<Object, Object> forwardedProps = new LinkedHashMap<>();
        forwardedProps.put("tenant", "example");
        forwardedProps.put(42, "preserve-me");

        assertThatThrownBy(() -> factory.createRequestConfig(
                RunConfig.builder().build(),
                input(forwardedProps)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("string keys");
        assertThat(forwardedProps)
                .containsEntry("tenant", "example")
                .containsEntry(42, "preserve-me");
    }

    @Test
    void explicitExtensionsRejectReservedForwardedPropertyCollisionsStably() {
        RunAgentInput input = input(Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY,
                "caller-value"));

        assertThatThrownBy(() -> factory.createRequestConfig(
                RunConfig.builder().build(),
                input,
                extensions("show_sports_list", 0)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining(AdkRunExtensions.FORWARDED_PROPS_KEY);
    }

    @Test
    @SuppressWarnings("unchecked")
    void recursivelySnapshotsMutableRequestValues() {
        ObjectNode stateNode = new com.fasterxml.jackson.databind.ObjectMapper()
                .createObjectNode()
                .put("status", "active");
        List<Object> stateItems = new ArrayList<>(List.of(stateNode));
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("items", stateItems);

        ObjectNode forwardedNode = new com.fasterxml.jackson.databind.ObjectMapper()
                .createObjectNode()
                .put("region", "eu");
        List<Object> forwardedItems = new ArrayList<>(List.of(forwardedNode));
        Map<String, Object> forwardedProps = new LinkedHashMap<>();
        forwardedProps.put("items", forwardedItems);

        List<ToolCall> toolCalls = new ArrayList<>(List.of(new ToolCall(
                "call-1",
                new FunctionCall("show_sports_list", "{}"))));
        List<Message> messages = new ArrayList<>(List.of(
                new AssistantMessage("message-1", "calling tool", null, toolCalls)));

        List<Object> enumValues = new ArrayList<>(List.of("football"));
        Map<String, Object> sportProperty = new LinkedHashMap<>();
        sportProperty.put("type", "string");
        sportProperty.put("enum", enumValues);
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("sport", sportProperty);
        List<String> required = new ArrayList<>(List.of("sport"));
        List<Tool> tools = new ArrayList<>(List.of(new Tool(
                "show_sports_list",
                "Shows sports",
                new ToolParameters(properties, required))));
        List<Context> contexts = new ArrayList<>(List.of(new Context("tenant", "example")));

        RunAgentInput mutableInput = new RunAgentInput(
                "thread-1",
                "run-1",
                state,
                messages,
                tools,
                contexts,
                forwardedProps);
        AdkAgUiRunContext context = AdkAgUiRunContext.from(factory.createRequestConfig(
                RunConfig.builder().build(),
                mutableInput)).orElseThrow();

        stateItems.clear();
        stateNode.put("status", "mutated");
        forwardedItems.clear();
        forwardedNode.put("region", "mutated");
        toolCalls.clear();
        messages.clear();
        enumValues.add("rugby");
        sportProperty.put("description", "mutated");
        properties.clear();
        required.clear();
        tools.clear();
        contexts.clear();

        Map<?, ?> snapshottedState = (Map<?, ?>) context.input().state();
        assertThat((List<?>) snapshottedState.get("items")).singleElement().satisfies(value ->
                assertThat(((ObjectNode) value).get("status").asText()).isEqualTo("active"));
        Map<?, ?> snapshottedForwarded = (Map<?, ?>) context.input().forwardedProps();
        assertThat((List<?>) snapshottedForwarded.get("items")).singleElement().satisfies(value ->
                assertThat(((ObjectNode) value).get("region").asText()).isEqualTo("eu"));
        assertThat(context.input().messages()).singleElement().satisfies(message ->
                assertThat(((AssistantMessage) message).toolCalls()).hasSize(1));
        assertThat(context.input().context()).hasSize(1);
        assertThat(context.input().tools()).singleElement().satisfies(tool -> {
            assertThat(tool.parameters().properties()).containsKey("sport");
            assertThat((List<?>) ((Map<?, ?>) tool.parameters().properties().get("sport")).get("enum"))
                    .isEqualTo(List.of("football"));
            assertThat(tool.parameters().required()).containsExactly("sport");
        });
        assertThatThrownBy(() -> ((Map<Object, Object>) snapshottedState).put("new", "value"))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void reentrantCloseDuringResourceCreationDoesNotRetainTheResource() {
        RequestResourceRegistry registry = RequestResourceRegistry.create();
        AtomicInteger closeCount = new AtomicInteger();
        AutoCloseable resource = closeCount::incrementAndGet;

        assertThatThrownBy(() -> registry.computeIfAbsent("resource", () -> {
            registry.close();
            return resource;
        }))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("request resource registry is closed");
        assertThat(closeCount).hasValue(1);
        assertThatThrownBy(() -> registry.computeIfAbsent("resource", () -> resource))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("request resource registry is closed");
        assertThat(closeCount).hasValue(1);
    }

    @Test
    void closesRegisteredRequestResourcesExactlyOnce() {
        RunConfig request = factory.createRequestConfig(
                RunConfig.builder().build(),
                input(Map.of()));
        AdkAgUiRunContext context = AdkAgUiRunContext.from(request).orElseThrow();
        AtomicInteger closeCount = new AtomicInteger();
        AutoCloseable resource = closeCount::incrementAndGet;

        AtomicInteger duplicateFactoryCalls = new AtomicInteger();
        context.resources().register(resource);
        assertThat(context.resources().computeIfAbsent("same", () -> resource))
                .isSameAs(resource);
        assertThat(context.resources().computeIfAbsent("same", () -> {
            duplicateFactoryCalls.incrementAndGet();
            return resource;
        })).isSameAs(resource);
        assertThat(duplicateFactoryCalls).hasValue(0);

        context.resources().close();
        context.resources().close();
        assertThatThrownBy(() -> context.resources().register(resource))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("request resource registry is closed");

        assertThat(closeCount).hasValue(1);
    }

    @Test
    void cancellationTokenTransitionsOnlyOnce() {
        AdkAgUiRunContext context = AdkAgUiRunContext.from(factory.createRequestConfig(
                RunConfig.builder().build(),
                input(Map.of()))).orElseThrow();

        assertThat(context.cancellation().isCancelled()).isFalse();
        assertThat(context.cancellation().cancel()).isTrue();
        assertThat(context.cancellation().cancel()).isFalse();
        assertThat(context.cancellation().isCancelled()).isTrue();
    }

    @Test
    void exposesOptionsOnTheApprovedAgentBuilder() {
        assertThat(GoogleAdkAgent.builder().options(AdkAgUiOptions.defaults())).isNotNull();
    }

    @Test
    void mergesMetadataEnricherOutputIntoTheRequestMetadata() {
        RunInputValidator validator = new RunInputValidator();
        RunContextFactory enrichedFactory = new RunContextFactory(
                "test-app",
                "user-1",
                "session-1",
                validator,
                context -> Map.of("executionContext", "some-context"));
        RunConfig request = enrichedFactory.createRequestConfig(
                RunConfig.builder().build(),
                input(Map.of("tenant", "example")));
        assertThat(request.customMetadata())
                .containsEntry("executionContext", "some-context");
    }

    @Test
    void metadataEnricherMayUseTheResolvedRunContext() {
        RunContextFactory enrichedFactory = new RunContextFactory(
                "test-app",
                "user-1",
                "session-1",
                new RunInputValidator(),
                context -> Map.of(
                        "resolvedUserId", context.userId(),
                        "hasResources", context.resources() != null));
        RunConfig request = enrichedFactory.createRequestConfig(
                RunConfig.builder().build(),
                input(Map.of()));
        assertThat(request.customMetadata())
                .containsEntry("resolvedUserId", "user-1")
                .containsEntry("hasResources", true);
    }

    @Test
    void metadataEnricherCannotOverrideTheReservedContextKey() {
        RunContextFactory enrichedFactory = new RunContextFactory(
                "test-app",
                "user-1",
                "session-1",
                new RunInputValidator(),
                context -> Map.of(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY, "oops"));
        assertThatThrownBy(() -> enrichedFactory.createRequestConfig(
                RunConfig.builder().build(),
                input(Map.of())))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must not override reserved key");
    }

    @Test
    void nullMetadataEnricherOutputIsIgnored() {
        RunContextFactory enrichedFactory = new RunContextFactory(
                "test-app",
                "user-1",
                "session-1",
                new RunInputValidator(),
                context -> null);
        RunConfig request = enrichedFactory.createRequestConfig(
                RunConfig.builder().build(),
                input(Map.of()));
        assertThat(request.customMetadata())
                .containsKey(AdkAgUiRunContext.RUN_CONFIG_METADATA_KEY);
    }

    private static RunAgentInput input(Object forwardedProps) {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of("status", "active"),
                List.of(new UserMessage("message-1", "hello")),
                List.of(new Tool(
                        "show_sports_list",
                        "Shows sports",
                        new ToolParameters(Map.of(), List.of()))),
                List.of(),
                forwardedProps);
    }

    private static AdkRunExtensions extensions(String name, int position) {
        return new AdkRunExtensions(
                "parent-1",
                List.of(new RawToolSchema(
                        position,
                        name,
                        new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode())));
    }
}
