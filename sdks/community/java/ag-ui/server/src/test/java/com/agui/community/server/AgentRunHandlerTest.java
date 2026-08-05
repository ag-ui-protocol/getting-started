package com.agui.community.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.serialization.SerializationException;
import java.util.List;
import java.util.concurrent.SubmissionPublisher;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class AgentRunHandlerTest {

    private static final RunAgentInput INPUT = new RunAgentInput("t1", "r1", List.of(), List.of());

    @Test
    void relaysEachEventAsAnSseFrameAndCloses() throws Exception {
        Agent agent = input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.submit(new RunStartedEvent("t1", "r1"));
            publisher.submit(new TextMessageContentEvent("m1", "hi"));
            publisher.close();
        };
        AgentRunHandler handler = new AgentRunHandler(agent, FakeSerializer.returning(INPUT));
        RecordingEventSink sink = new RecordingEventSink();

        handler.run(INPUT, sink).get(5, TimeUnit.SECONDS);

        assertEquals(2, sink.frames.size());
        assertEquals("data: RUN_STARTED\n\n", sink.frames.get(0));
        assertEquals("data: TEXT_MESSAGE_CONTENT\n\n", sink.frames.get(1));
        assertTrue(sink.closed);
    }

    @Test
    void surfacesAgentFailureAsTerminalRunErrorFrame() throws Exception {
        Agent agent = input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.closeExceptionally(new RuntimeException("boom"));
        };
        AgentRunHandler handler = new AgentRunHandler(agent, FakeSerializer.returning(INPUT));
        RecordingEventSink sink = new RecordingEventSink();

        handler.run(INPUT, sink).get(5, TimeUnit.SECONDS);

        // The failure is surfaced in band as a terminal RUN_ERROR frame.
        assertEquals("data: RUN_ERROR\n\n", sink.frames.get(sink.frames.size() - 1));
        assertTrue(sink.closed);
    }

    @Test
    void parseDelegatesToSerializer() {
        AgentRunHandler handler = new AgentRunHandler(input -> subscriber -> { },
                FakeSerializer.returning(INPUT));

        assertEquals(INPUT, handler.parse("{}"));
    }

    @Test
    void parsePropagatesSerializationException() {
        AgentRunHandler handler = new AgentRunHandler(input -> subscriber -> { },
                FakeSerializer.failingDeserialize());

        assertThrows(SerializationException.class, () -> handler.parse("not json"));
    }
}
