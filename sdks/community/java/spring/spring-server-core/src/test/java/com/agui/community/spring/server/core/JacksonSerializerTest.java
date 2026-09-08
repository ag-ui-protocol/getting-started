package com.agui.community.spring.server.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.EventType;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.interrupt.Interrupt;
import com.agui.community.core.interrupt.InterruptOutcome;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.Role;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.tool.Tool;
import java.util.List;
import org.junit.jupiter.api.Test;

class JacksonSerializerTest {

    private final JacksonSerializer serializer = new JacksonSerializer();

    @Test
    void roundTripsEventViaTypeDiscriminator() {
        Event original = new TextMessageStartEvent("m1", Role.ASSISTANT);

        String json = serializer.serialize(original);
        Event back = serializer.deserialize(json, Event.class);

        assertTrue(json.contains("\"type\":\"TEXT_MESSAGE_START\""), json);
        assertTrue(json.contains("\"role\":\"assistant\""), json);
        assertInstanceOf(TextMessageStartEvent.class, back);
        assertEquals(original, back);
    }

    @Test
    void roundTripsMessageViaRoleDiscriminator() {
        Message original = new UserMessage("m1", "hello");

        String json = serializer.serialize(original);
        Message back = serializer.deserialize(json, Message.class);

        assertTrue(json.contains("\"role\":\"user\""), json);
        assertInstanceOf(UserMessage.class, back);
        assertEquals(original, back);
    }

    @Test
    void roundTripsRunAgentInputWithPolymorphicMessages() {
        RunAgentInput original = new RunAgentInput("t1", "r1",
                List.of(new UserMessage("m1", "hi"), new AssistantMessage("m2", "hello there")),
                List.of());

        String json = serializer.serialize(original);
        RunAgentInput back = serializer.deserialize(json, RunAgentInput.class);

        assertEquals(original, back);
        assertInstanceOf(UserMessage.class, back.messages().get(0));
        assertInstanceOf(AssistantMessage.class, back.messages().get(1));
    }

    @Test
    void deserializesToolWhoseParametersOmitOptionalSchemaFields() {
        // JSON Schema "properties" and "required" are optional; clients omit them
        // for tools with no required arguments.
        String json = """
                {
                  "threadId": "t1",
                  "runId": "r1",
                  "messages": [],
                  "tools": [
                    {"name": "ping", "description": "Ping the server", "parameters": {"type": "object"}}
                  ]
                }
                """;

        RunAgentInput input = serializer.deserialize(json, RunAgentInput.class);

        Tool tool = input.tools().get(0);
        assertEquals("ping", tool.name());
        assertTrue(tool.parameters().properties().isEmpty());
        assertTrue(tool.parameters().required().isEmpty());
        assertEquals("object", tool.parameters().type());
    }

    @Test
    void deserializeListRoundTripsPolymorphicMessages() {
        String json = "[{\"role\":\"user\",\"id\":\"m1\",\"content\":\"hi\"},"
                + "{\"role\":\"assistant\",\"id\":\"m2\",\"content\":\"yo\"}]";

        List<Message> messages = serializer.deserializeList(json, Message.class);

        assertEquals(2, messages.size());
        assertInstanceOf(UserMessage.class, messages.get(0));
        assertInstanceOf(AssistantMessage.class, messages.get(1));
    }

    @Test
    void eventTypeRoundTripsThroughItsWireValue() {
        assertEquals("\"CUSTOM\"", serializer.serialize(EventType.CUSTOM));
        assertEquals(EventType.RUN_STARTED, serializer.deserialize("\"RUN_STARTED\"", EventType.class));
    }

    @Test
    void serializeWrapsFailuresInSerializationException() {
        // A bean with no serializable properties trips Jackson's FAIL_ON_EMPTY_BEANS.
        assertThrows(SerializationException.class, () -> serializer.serialize(new Object()));
    }

    @Test
    void deserializeWrapsFailuresInSerializationException() {
        assertThrows(SerializationException.class, () -> serializer.deserialize("not json", Event.class));
    }

    @Test
    void deserializeListWrapsFailuresInSerializationException() {
        assertThrows(SerializationException.class, () -> serializer.deserializeList("not json", Message.class));
    }

    @Test
    void serializesRunFinishedInterruptOutcomeWithTypeDiscriminator() {
        Event original = new RunFinishedEvent("t1", "r1",
                new InterruptOutcome(List.of(new Interrupt("c1", "input_required", "Confirm?"))),
                null, null, null);

        String json = serializer.serialize(original);
        Event back = serializer.deserialize(json, Event.class);

        assertTrue(json.contains("\"type\":\"RUN_FINISHED\""), json);
        assertTrue(json.contains("\"type\":\"interrupt\""), json);
        assertTrue(json.contains("\"reason\":\"input_required\""), json);
        RunFinishedEvent finished = assertInstanceOf(RunFinishedEvent.class, back);
        InterruptOutcome outcome = assertInstanceOf(InterruptOutcome.class, finished.outcome());
        assertEquals("c1", outcome.interrupts().get(0).id());
    }

    @Test
    void deserializesResumeWithLowercaseStatus() {
        String json = "{\"threadId\":\"t1\",\"runId\":\"r1\","
                + "\"resume\":[{\"interruptId\":\"c1\",\"status\":\"resolved\",\"payload\":\"yes\"}]}";

        RunAgentInput input = serializer.deserialize(json, RunAgentInput.class);

        assertEquals(1, input.resume().size());
        Resume resume = input.resume().get(0);
        assertEquals("c1", resume.interruptId());
        assertEquals(ResumeStatus.RESOLVED, resume.status());
        assertEquals("yes", resume.payload());
    }
}
