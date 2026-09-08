package com.agui.community.spring.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.spring.server.core.AgentNotFoundException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.SubmissionPublisher;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;

class AgUiControllerTest {

    private static final RunAgentInput INPUT = new RunAgentInput("t1", "r1", List.of(), List.of());

    /** Serializes events to their type wire value; deserializes any body to INPUT. */
    private static final Serializer SERIALIZER = new Serializer() {
        @Override
        public String serialize(Object value) {
            return ((Event) value).type().value();
        }

        @Override
        public <T> T deserialize(String json, Class<T> type) {
            return type.cast(INPUT);
        }

        @Override
        public <T> List<T> deserializeList(String json, Class<T> elementType) {
            throw new UnsupportedOperationException();
        }
    };

    @Test
    void routesToAgentByIdInPath() {
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of(
                "weather", agentEmitting(new RunStartedEvent("t1", "r1")),
                "support", agentEmitting(new RunFinishedEvent("t1", "r1")))), SERIALIZER);

        assertEquals(List.of("RUN_STARTED"), data(controller.run("weather", "{}")));
        assertEquals(List.of("RUN_FINISHED"), data(controller.run("support", "{}")));
    }

    @Test
    void unknownAgentIdThrowsNotFound() {
        AgUiController controller = new AgUiController(
                AgentRegistry.of(Map.of("weather", agentEmitting(new RunStartedEvent("t1", "r1")))),
                SERIALIZER);

        assertThrows(AgentNotFoundException.class, () -> controller.run("missing", "{}"));
    }

    @Test
    void aliasRunsTheSoleAgent() {
        AgUiController controller = new AgUiController(
                AgentRegistry.of(Map.of("only", agentEmitting(new RunStartedEvent("t1", "r1")))),
                SERIALIZER);

        assertEquals(List.of("RUN_STARTED"), data(controller.runDefault("{}")));
    }

    @Test
    void aliasThrowsNotFoundWhenNotExactlyOneAgent() {
        AgUiController many = new AgUiController(AgentRegistry.of(Map.of(
                "a", agentEmitting(new RunStartedEvent("t1", "r1")),
                "b", agentEmitting(new RunFinishedEvent("t1", "r1")))), SERIALIZER);

        assertThrows(AgentNotFoundException.class, () -> many.runDefault("{}"));
    }

    @Test
    void runErrorEventEmittedInBandWhenAgentFails() {
        Agent failing = input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.closeExceptionally(new RuntimeException("boom"));
        };
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of("x", failing)), SERIALIZER);

        assertEquals(List.of("RUN_ERROR"), data(controller.run("x", "{}")));
    }

    @Test
    void runErrorFallsBackToExceptionTypeWhenMessageIsNull() {
        Agent failing = input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.closeExceptionally(new IllegalStateException()); // null message
        };
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of("x", failing)), SERIALIZER);

        assertEquals(List.of("RUN_ERROR"), data(controller.run("x", "{}")));
    }

    @Test
    void exceptionHandlersReturnDescriptiveMessages() {
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of()), SERIALIZER);

        assertTrue(controller.onUnknownAgent(AgentNotFoundException.byId("ghost")).contains("ghost"));
        assertTrue(controller.onMalformedRequest(new SerializationException("bad json")).contains("bad json"));
    }

    private static List<String> data(Flux<ServerSentEvent<String>> flux) {
        return flux.map(ServerSentEvent::data).collectList().block(Duration.ofSeconds(5));
    }

    private static Agent agentEmitting(Event event) {
        return input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.submit(event);
            publisher.close();
        };
    }
}
