package com.agui.community.spring.server;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.spring.server.core.AgentNotFoundException;
import java.util.Objects;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import reactor.adapter.JdkFlowAdapter;
import reactor.core.publisher.Flux;

/**
 * A reactive AG-UI endpoint that can serve several agents. It accepts a
 * {@code POST} whose JSON body is a {@link RunAgentInput}, runs the addressed
 * {@link Agent}, and streams the resulting {@link Event}s back as
 * {@code text/event-stream}.
 *
 * <p>The path segment after the base selects the agent by id
 * ({@code /agent/{id}}); an unknown id yields {@code 404}. When exactly one
 * agent is registered, the bare base path is also served as an alias. The base
 * path defaults to {@code /agent} and can be overridden with the
 * {@code ag-ui.server.path} property. This is the Spring WebFlux counterpart to
 * the JDK-based handler in the {@code server} module and is wire-compatible with
 * the {@code HttpAgent} client.
 */
@RestController
public class AgUiController {

    private final AgentRegistry registry;
    private final Serializer serializer;

    /**
     * Creates the controller.
     *
     * @param registry   the agents addressable by this endpoint (required)
     * @param serializer the serializer used to read input and encode events
     *                   (required)
     */
    public AgUiController(AgentRegistry registry, Serializer serializer) {
        this.registry = Objects.requireNonNull(registry, "registry must not be null");
        this.serializer = Objects.requireNonNull(serializer, "serializer must not be null");
    }

    /**
     * Runs the agent addressed by {@code id} and streams its events.
     *
     * @param id   the agent id from the request path
     * @param body the JSON-encoded {@link RunAgentInput}
     * @return the agent's events as Server-Sent Events
     */
    @PostMapping(value = "${ag-ui.server.path:/agent}/{id}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> run(@PathVariable("id") String id, @RequestBody String body) {
        Agent agent = registry.find(id).orElseThrow(() -> AgentNotFoundException.byId(id));
        return stream(agent, body);
    }

    /**
     * Single-agent alias: runs the sole registered agent on the base path.
     *
     * @param body the JSON-encoded {@link RunAgentInput}
     * @return the agent's events as Server-Sent Events
     */
    @PostMapping(value = "${ag-ui.server.path:/agent}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> runDefault(@RequestBody String body) {
        Agent agent = registry.single().orElseThrow(AgentNotFoundException::noSingleAgent);
        return stream(agent, body);
    }

    private Flux<ServerSentEvent<String>> stream(Agent agent, String body) {
        RunAgentInput input = serializer.deserialize(body, RunAgentInput.class);
        return JdkFlowAdapter.flowPublisherToFlux(agent.run(input))
                // Surface run failures in band as a terminal RUN_ERROR event,
                // matching the protocol rather than abruptly closing the stream.
                .onErrorResume(throwable -> Flux.just((Event) new RunErrorEvent(describe(throwable))))
                .map(event -> ServerSentEvent.builder(serializer.serialize(event)).build());
    }

    @ExceptionHandler(AgentNotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    String onUnknownAgent(AgentNotFoundException e) {
        return e.getMessage();
    }

    @ExceptionHandler(SerializationException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    String onMalformedRequest(SerializationException e) {
        return "Invalid AG-UI request: " + e.getMessage();
    }

    private static String describe(Throwable throwable) {
        String message = throwable.getMessage();
        return Objects.nonNull(message) ? message : throwable.getClass().getSimpleName();
    }
}
