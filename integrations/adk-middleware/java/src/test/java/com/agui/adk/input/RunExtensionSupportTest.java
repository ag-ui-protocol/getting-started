package com.agui.adk.input;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RunExtensionSupportTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void attachesExtensionsWithoutMutatingOfficialInputOrForwardedProps() throws Exception {
        Map<String, Object> forwardedProps = new LinkedHashMap<>();
        forwardedProps.put("tenant", "example");
        RunAgentInput source = officialInput(forwardedProps);
        ObjectNode schema = (ObjectNode) mapper.readTree("""
                {
                  "type":"object",
                  "$defs":{"sport":{"type":"object"}},
                  "properties":{"sports":{"type":"array","items":{"$ref":"#/$defs/sport"}}}
                }
                """);
        AdkRunExtensions extensions = new AdkRunExtensions(
                "parent-1",
                List.of(new RawToolSchema(0, "show_sports_list", schema)));

        RunAgentInput attached = RunExtensionSupport.attach(source, extensions);

        assertThat(attached).isNotSameAs(source);
        assertThat(source.forwardedProps()).isSameAs(forwardedProps);
        assertThat(source.forwardedProps()).isEqualTo(Map.of("tenant", "example"));
        assertThat(RunExtensionSupport.extract(attached)).contains(extensions);
        assertThat(forwardedProps(attached)).containsEntry("tenant", "example");
        schema.remove("$defs");
        assertThat(RunExtensionSupport.extract(attached).orElseThrow()
                .rawToolSchemas().getFirst().schema().has("$defs")).isTrue();
        assertThat(forwardedProps).containsExactlyEntriesOf(Map.of("tenant", "example"));
    }

    @Test
    void preservesOfficialResumeEntriesWhenCopyingForwardedProps() {
        Resume resume = new Resume("interrupt-1", ResumeStatus.RESOLVED, Map.of("approved", true));
        RunAgentInput source = new RunAgentInput(
                "thread", "run", Map.of(), List.of(), List.of(), List.of(), Map.of(), List.of(resume));

        RunAgentInput attached = RunExtensionSupport.attach(source, extensions());
        RunAgentInput detached = RunExtensionSupport.detach(attached);

        assertThat(attached.resume()).containsExactly(resume);
        assertThat(detached.resume()).containsExactly(resume);
    }

    @Test
    void rejectsNonMapForwardedPropsWithoutDiscardingThem() {
        RunAgentInput source = officialInput(List.of("opaque"));

        assertThatThrownBy(() -> RunExtensionSupport.attach(source, extensions()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("forwardedProps");
        assertThat(source.forwardedProps()).isEqualTo(List.of("opaque"));
    }

    @Test
    void rejectsNonStringForwardedPropertyKeysWithoutDiscardingThem() {
        Map<Object, Object> forwardedProps = new LinkedHashMap<>();
        forwardedProps.put("tenant", "example");
        forwardedProps.put(42, "preserve-me");

        assertThatThrownBy(() -> RunExtensionSupport.attach(officialInput(forwardedProps), extensions()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("string keys");
        assertThat(forwardedProps)
                .containsEntry("tenant", "example")
                .containsEntry(42, "preserve-me");
    }

    @Test
    void rejectsReservedForwardedPropertyCollision() {
        Map<String, Object> forwardedProps = new LinkedHashMap<>();
        forwardedProps.put(AdkRunExtensions.FORWARDED_PROPS_KEY, "caller-value");
        RunAgentInput source = officialInput(forwardedProps);

        assertThatThrownBy(() -> RunExtensionSupport.attach(source, extensions()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(AdkRunExtensions.FORWARDED_PROPS_KEY);
        assertThat(forwardedProps).containsEntry(AdkRunExtensions.FORWARDED_PROPS_KEY, "caller-value");
    }

    @Test
    void rejectsDuplicateRawToolSchemaPositions() {
        RawToolSchema first = new RawToolSchema(0, "first", mapper.createObjectNode());
        RawToolSchema duplicate = new RawToolSchema(0, "second", mapper.createObjectNode());

        assertThatThrownBy(() -> new AdkRunExtensions("parent-1", List.of(first, duplicate)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("raw tool schema positions must be unique");
    }

    @Test
    void rejectsBlankRawToolSchemaName() {
        assertThatThrownBy(() -> new RawToolSchema(0, "  ", mapper.createObjectNode()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("name must not be blank");
    }

    @Test
    void rejectsNegativeRawToolSchemaPosition() {
        assertThatThrownBy(() -> new RawToolSchema(-1, "show_sports_list", mapper.createObjectNode()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("position must be non-negative");
    }

    @Test
    void extensionDefensivelyCopiesRawToolSchemasAndSchemas() {
        JsonNode schema = mapper.createObjectNode().put("type", "object");
        List<RawToolSchema> schemas = new ArrayList<>();
        schemas.add(new RawToolSchema(0, "show_sports_list", schema));

        AdkRunExtensions extensions = new AdkRunExtensions("parent-1", schemas);
        schemas.clear();
        ((ObjectNode) extensions.rawToolSchemas().getFirst().schema()).remove("type");

        assertThat(extensions.rawToolSchemas()).hasSize(1);
        assertThat(extensions.rawToolSchemas().getFirst().schema().get("type").asText())
                .isEqualTo("object");
    }

    @Test
    void extractsWireDecodedMapExtensions() {
        RunAgentInput source = officialInput(Map.of(
                "tenant", "example",
                AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "parentRunId", "parent-1",
                        "rawToolSchemas", List.of(Map.of(
                                "position", 0,
                                "name", "show_sports_list",
                                "schema", Map.of(
                                        "type", "object",
                                        "properties", Map.of(
                                                "sports", Map.of("type", "array"))))))));

        assertThat(RunExtensionSupport.extract(source)).hasValueSatisfying(extracted -> {
            assertThat(extracted.parentRunId()).isEqualTo("parent-1");
            assertThat(extracted.rawToolSchemas()).singleElement().satisfies(schema -> {
                assertThat(schema.position()).isZero();
                assertThat(schema.name()).isEqualTo("show_sports_list");
                assertThat(schema.schema().at("/properties/sports/type").asText()).isEqualTo("array");
            });
        });
        assertThat(forwardedProps(source)).containsEntry("tenant", "example");
    }

    @Test
    void rejectsLegacyConfirmationActionAtWireBoundary() {
        RunAgentInput source = officialInput(Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "action", Map.of(
                                "kind", "confirmation",
                                "invocationId", "invocation-1",
                                "toolCallId", "call-1",
                                "approved", true))));

        assertThatThrownBy(() -> RunExtensionSupport.extract(source))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("action.kind is unsupported");
    }

    @Test
    void preservesAuthActionDecoding() {
        RunAgentInput source = officialInput(Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "action", Map.of(
                                "kind", "auth",
                                "requestId", "request-1",
                                "input", Map.of("token", "value")))));

        assertThat(RunExtensionSupport.extract(source).orElseThrow().action())
                .isEqualTo(new AdkRunExtensions.AuthAction(
                        "request-1", Map.of("token", "value")));
    }

    @Test
    void rejectsNegativeRawToolSchemaPositionAtWireBoundary() {
        RunAgentInput source = officialInput(Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of(
                        "rawToolSchemas", List.of(Map.of(
                                "position", -1,
                                "name", "show_sports_list",
                                "schema", Map.of("type", "object"))))));

        assertThatThrownBy(() -> RunExtensionSupport.extract(source))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("position must be non-negative");
    }

    @Test
    void rejectsNullRawToolSchemaEntryAtWireBoundary() {
        Map<String, Object> extension = new LinkedHashMap<>();
        extension.put("rawToolSchemas", java.util.Collections.singletonList(null));
        RunAgentInput source = officialInput(Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY, extension));

        assertThatThrownBy(() -> RunExtensionSupport.extract(source))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining("rawToolSchemas entries must be objects");
    }

    @Test
    void rejectsMalformedReservedExtensionValues() {
        RunAgentInput source = officialInput(Map.of(
                AdkRunExtensions.FORWARDED_PROPS_KEY, "not-an-extension"));

        assertThatThrownBy(() -> RunExtensionSupport.extract(source))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("INVALID_RUN_INPUT")
                .hasMessageContaining(AdkRunExtensions.FORWARDED_PROPS_KEY);
    }

    @Test
    void detachReturnsCopiedOfficialInputWithoutReservedProperty() {
        RunAgentInput source = officialInput(Map.of("tenant", "example"));
        RunAgentInput attached = RunExtensionSupport.attach(source, extensions());

        RunAgentInput detached = RunExtensionSupport.detach(attached);

        assertThat(detached).isNotSameAs(attached);
        assertThat(detached.threadId()).isEqualTo(attached.threadId());
        assertThat(detached.runId()).isEqualTo(attached.runId());
        assertThat(detached.state()).isSameAs(attached.state());
        assertThat(detached.messages()).isSameAs(attached.messages());
        assertThat(detached.tools()).isSameAs(attached.tools());
        assertThat(detached.context()).isSameAs(attached.context());
        assertThat(detached.forwardedProps()).isEqualTo(Map.of("tenant", "example"));
        assertThat(RunExtensionSupport.extract(detached)).isEmpty();
        assertThat(RunExtensionSupport.extract(attached)).contains(extensions());
    }

    private AdkRunExtensions extensions() {
        return new AdkRunExtensions(
                "parent-1",
                List.of(new RawToolSchema(0, "show_sports_list", mapper.createObjectNode())));
    }

    @SuppressWarnings("unchecked")
    private Map<Object, Object> forwardedProps(RunAgentInput input) {
        return (Map<Object, Object>) input.forwardedProps();
    }

    private RunAgentInput officialInput(Object forwardedProps) {
        return new RunAgentInput(
                "thread-1",
                "run-1",
                Map.of("status", "active"),
                List.of(),
                List.of(),
                List.of(),
                forwardedProps);
    }
}
