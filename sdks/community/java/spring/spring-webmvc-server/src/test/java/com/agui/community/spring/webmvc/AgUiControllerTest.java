package com.agui.community.spring.webmvc;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.spring.server.core.AgentNotFoundException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Flow;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

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
    void routesToAgentByIdAndStreamsViaSseEmitter() throws Exception {
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of(
                "weather", syncAgent(new RunStartedEvent("t1", "r1")))), SERIALIZER);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(controller)
                .addPlaceholderValue("ag-ui.server.path", "/agent").build();

        MvcResult result = mvc.perform(post("/agent/weather")
                        .contentType(MediaType.APPLICATION_JSON)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .content("{}"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mvc.perform(asyncDispatch(result))
                .andExpect(status().isOk())
                .andExpect(content().string(Matchers.containsString("RUN_STARTED")));
    }

    @Test
    void unknownAgentIdThrowsNotFound() {
        AgUiController controller = new AgUiController(
                AgentRegistry.of(Map.of("weather", syncAgent(new RunStartedEvent("t1", "r1")))),
                SERIALIZER);

        assertThrows(AgentNotFoundException.class, () -> controller.run("missing", "{}"));
    }

    @Test
    void aliasThrowsNotFoundWhenNotExactlyOneAgent() {
        AgUiController many = new AgUiController(AgentRegistry.of(Map.of(
                "a", syncAgent(new RunStartedEvent("t1", "r1")),
                "b", syncAgent(new RunFinishedEvent("t1", "r1")))), SERIALIZER);

        assertThrows(AgentNotFoundException.class, () -> many.runDefault("{}"));
    }

    @Test
    void runErrorEventEmittedInBandWhenAgentFails() throws Exception {
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of(
                "x", syncErroringAgent(new RuntimeException("boom")))), SERIALIZER);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(controller)
                .addPlaceholderValue("ag-ui.server.path", "/agent").build();

        MvcResult result = mvc.perform(post("/agent/x")
                        .contentType(MediaType.APPLICATION_JSON)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .content("{}"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mvc.perform(asyncDispatch(result))
                .andExpect(status().isOk())
                .andExpect(content().string(Matchers.containsString("RUN_ERROR")));
    }

    @Test
    void runErrorFallsBackToExceptionTypeWhenMessageIsNull() throws Exception {
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of(
                "x", syncErroringAgent(new IllegalStateException()))), SERIALIZER);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(controller)
                .addPlaceholderValue("ag-ui.server.path", "/agent").build();

        MvcResult result = mvc.perform(post("/agent/x")
                        .contentType(MediaType.APPLICATION_JSON)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .content("{}"))
                .andExpect(request().asyncStarted())
                .andReturn();

        mvc.perform(asyncDispatch(result))
                .andExpect(status().isOk())
                .andExpect(content().string(Matchers.containsString("RUN_ERROR")));
    }

    @Test
    void exceptionHandlersReturnDescriptiveMessages() {
        AgUiController controller = new AgUiController(AgentRegistry.of(Map.of()), SERIALIZER);

        assertTrue(controller.onUnknownAgent(AgentNotFoundException.byId("ghost")).contains("ghost"));
        assertTrue(controller.onMalformedRequest(new SerializationException("bad json")).contains("bad json"));
    }

    /** Signals onError synchronously when the subscriber requests. */
    private static Agent syncErroringAgent(Throwable error) {
        return input -> subscriber -> subscriber.onSubscribe(new Flow.Subscription() {
            private boolean served;

            @Override
            public void request(long n) {
                if (served) {
                    return;
                }
                served = true;
                subscriber.onError(error);
            }

            @Override
            public void cancel() {
                // no-op
            }
        });
    }

    /** Emits a single event synchronously when the subscriber requests, then completes. */
    private static Agent syncAgent(Event event) {
        return input -> subscriber -> subscriber.onSubscribe(new Flow.Subscription() {
            private boolean served;

            @Override
            public void request(long n) {
                if (served) {
                    return;
                }
                served = true;
                subscriber.onNext(event);
                subscriber.onComplete();
            }

            @Override
            public void cancel() {
                // no-op
            }
        });
    }
}
