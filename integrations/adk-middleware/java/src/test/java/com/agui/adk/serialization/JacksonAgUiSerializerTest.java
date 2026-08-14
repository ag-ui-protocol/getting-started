package com.agui.adk.serialization;

import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.EventType;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.interrupt.*;
import com.agui.community.core.message.*;
import com.agui.community.core.serialization.SerializationException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Contract tests for the canonical official AG-UI Jackson serializer. */
class JacksonAgUiSerializerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JacksonAgUiSerializer serializer = new JacksonAgUiSerializer(JSON);

    @Test
    void supportsEveryOfficialEventDiscriminator() throws Exception {
        Map<EventType, String> examples = Map.ofEntries(
                event("RUN_STARTED", "\"threadId\":\"t\",\"runId\":\"r\""),
                event("RUN_FINISHED", "\"threadId\":\"t\",\"runId\":\"r\""),
                event("RUN_ERROR", "\"message\":\"failed\""),
                event("STEP_STARTED", "\"stepName\":\"step\""),
                event("STEP_FINISHED", "\"stepName\":\"step\""),
                event("TEXT_MESSAGE_START", "\"messageId\":\"m\",\"role\":\"assistant\""),
                event("TEXT_MESSAGE_CONTENT", "\"messageId\":\"m\",\"delta\":\"x\""),
                event("TEXT_MESSAGE_END", "\"messageId\":\"m\""),
                event("TEXT_MESSAGE_CHUNK", "\"messageId\":\"m\",\"role\":\"assistant\",\"delta\":\"x\""),
                event("TOOL_CALL_START", "\"toolCallId\":\"c\",\"toolCallName\":\"tool\""),
                event("TOOL_CALL_ARGS", "\"toolCallId\":\"c\",\"delta\":\"{}\""),
                event("TOOL_CALL_END", "\"toolCallId\":\"c\""),
                event("TOOL_CALL_CHUNK", "\"toolCallId\":\"c\",\"toolCallName\":\"tool\",\"delta\":\"{}\""),
                event("TOOL_CALL_RESULT", "\"messageId\":\"m\",\"toolCallId\":\"c\",\"content\":\"ok\",\"role\":\"tool\""),
                event("REASONING_START", "\"messageId\":\"m\""),
                event("REASONING_END", "\"messageId\":\"m\""),
                event("REASONING_MESSAGE_START", "\"messageId\":\"m\",\"role\":\"reasoning\""),
                event("REASONING_MESSAGE_CONTENT", "\"messageId\":\"m\",\"delta\":\"x\""),
                event("REASONING_MESSAGE_END", "\"messageId\":\"m\""),
                event("REASONING_MESSAGE_CHUNK", "\"messageId\":\"m\",\"delta\":\"x\""),
                event("REASONING_ENCRYPTED_VALUE", "\"subtype\":\"message\",\"entityId\":\"m\",\"encryptedValue\":\"secret\""),
                event("STATE_SNAPSHOT", "\"snapshot\":{}"),
                event("STATE_DELTA", "\"delta\":[]"),
                event("MESSAGES_SNAPSHOT", "\"messages\":[]"),
                event("ACTIVITY_SNAPSHOT", "\"messageId\":\"m\",\"activityType\":\"PLAN\",\"content\":{}"),
                event("ACTIVITY_DELTA", "\"messageId\":\"m\",\"activityType\":\"PLAN\",\"patch\":[]"),
                event("RAW", "\"event\":{}"),
                event("CUSTOM", "\"name\":\"custom\",\"value\":{}"),
                event("META_EVENT", "\"metaType\":\"feedback\",\"payload\":{}")
        );

        assertThat(examples.keySet()).containsExactlyInAnyOrder(EventType.values());
        for (Map.Entry<EventType, String> example : examples.entrySet()) {
            Event decoded = serializer.deserialize(example.getValue(), Event.class);
            assertThat(decoded.type()).isEqualTo(example.getKey());
            assertThat(JSON.readTree(serializer.serialize(decoded))).isEqualTo(JSON.readTree(example.getValue()));
        }
    }

    @Test
    void supportsEveryMessageRoleAndMessageLists() throws Exception {
        List<Message> messages = List.of(
                new DeveloperMessage("d", "developer"),
                new SystemMessage("s", "system"),
                new AssistantMessage("a", "assistant", null, List.of(
                        new ToolCall("c", new FunctionCall("tool", "{}")))),
                new UserMessage("u", "user"),
                new ToolMessage("t", "result", "c"));

        String json = serializer.serialize(messages);
        List<Message> decoded = serializer.deserializeList(json, Message.class);

        assertThat(decoded).isEqualTo(messages);
        assertThat(JSON.readTree(json).findValuesAsText("role"))
                .containsExactly("developer", "system", "assistant", "user", "tool");
    }

    @Test
    void supportsLowercaseOutcomesAndResumeStatuses() throws Exception {
        List<RunOutcome> outcomes = List.of(
                new SuccessOutcome(),
                new InterruptOutcome(List.of(new Interrupt("i", "approval", "Approve?"))));
        for (RunOutcome outcome : outcomes) {
            String json = serializer.serialize(outcome);
            assertThat(serializer.deserialize(json, RunOutcome.class)).isEqualTo(outcome);
        }
        assertThat(serializer.serialize(outcomes.get(0))).isEqualTo("{\"type\":\"success\"}");
        assertThat(JSON.readTree(serializer.serialize(outcomes.get(1))).path("type").asText()).isEqualTo("interrupt");

        for (ResumeStatus status : ResumeStatus.values()) {
            Resume resume = new Resume("i", status, Map.of("answer", true));
            String json = serializer.serialize(resume);
            assertThat(serializer.deserialize(json, Resume.class)).isEqualTo(resume);
            assertThat(JSON.readTree(json).path("status").asText()).isEqualTo(status.value());
        }
    }

    @Test
    void acceptsEnumNameResumeStatusesInRunAgentInput() {
        RunAgentInput input = serializer.deserialize(
                "{\"threadId\":\"t\",\"runId\":\"r\","
                        + "\"messages\":[{\"id\":\"m\",\"role\":\"user\",\"content\":\"hi\"}],"
                        + "\"tools\":[],\"context\":[],"
                        + "\"resume\":[{\"interruptId\":\"i\",\"status\":\"RESOLVED\",\"payload\":{}}]}",
                RunAgentInput.class);

        Resume resume = input.resume().getFirst();
        assertThat(resume.status()).isEqualTo(ResumeStatus.RESOLVED);
        assertThat(serializer.serialize(resume)).contains("\"status\":\"resolved\"");
    }

    @Test
    void ignoresUnknownInputFieldsOmitsProtocolNullsButPreservesPayloadNulls() throws Exception {
        String json = "{\"type\":\"CUSTOM\",\"name\":\"x\","
                + "\"value\":{\"nullable\":null},\"futureField\":true}";

        String encoded = serializer.serialize(serializer.deserialize(json, Event.class));
        JsonNode result = JSON.readTree(encoded);

        assertThat(result.has("futureField")).isFalse();
        assertThat(result.has("timestamp")).isFalse();
        assertThat(result.path("value").has("nullable")).isTrue();
    }

    @Test
    void retainsTimestampAndNeverLeaksRawEvent() throws Exception {
        Event event = serializer.deserialize("{\"type\":\"RUN_ERROR\",\"message\":\"x\","
                + "\"timestamp\":42,\"rawEvent\":{\"secret\":true}}", Event.class);

        JsonNode encoded = JSON.readTree(serializer.serialize(event));

        assertThat(encoded.path("timestamp").asLong()).isEqualTo(42L);
        assertThat(encoded.has("rawEvent")).isFalse();
    }

    @Test
    void wrapsMalformedUnknownAndMissingDiscriminatorFailures() {
        for (String json : List.of("{", "{}", "{\"type\":\"UNKNOWN\"}",
                "{\"type\":\"RUN_STARTED\",\"runId\":\"r\"}")) {
            assertThatThrownBy(() -> serializer.deserialize(json, Event.class))
                    .as(json)
                    .isInstanceOf(SerializationException.class);
        }
    }

    @Test
    void wrapsSerializationFailures() {
        assertThatThrownBy(() -> serializer.serialize(new Object() {
            public Object recursive() {
                return this;
            }
        })).isInstanceOf(SerializationException.class);
    }

    private static Map.Entry<EventType, String> event(String type, String fields) {
        return Map.entry(EventType.valueOf(type), "{\"type\":\"" + type + "\"," + fields + "}");
    }
}
