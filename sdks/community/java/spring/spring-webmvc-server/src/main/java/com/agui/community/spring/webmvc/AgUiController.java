package com.agui.community.spring.webmvc;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.spring.server.core.AgentNotFoundException;
import java.io.IOException;
import java.util.Objects;
import java.util.concurrent.Flow;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * A Servlet (Spring WebMVC) AG-UI endpoint that can serve several agents. It
 * accepts a {@code POST} whose JSON body is a {@link RunAgentInput}, runs the
 * addressed {@link Agent}, and streams the resulting {@link Event}s back as
 * {@code text/event-stream} through an {@link SseEmitter}.
 *
 * <p>The path segment after the base selects the agent by id
 * ({@code /agent/{id}}); an unknown id yields {@code 404}. When exactly one
 * agent is registered, the bare base path is also served as an alias. The base
 * path defaults to {@code /agent} and can be overridden with the
 * {@code ag-ui.server.path} property. This is the Servlet counterpart to the
 * reactive controller in {@code ag-ui-spring-webflux-server}, wire-compatible
 * with the {@code HttpAgent} client.
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
     * @return an emitter that streams the agent's events as Server-Sent Events
     */
    @PostMapping(value = "${ag-ui.server.path:/agent}/{id}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter run(@PathVariable("id") String id, @RequestBody String body) {
        Agent agent = registry.find(id).orElseThrow(() -> AgentNotFoundException.byId(id));
        return stream(agent, body);
    }

    /**
     * Single-agent alias: runs the sole registered agent on the base path.
     *
     * @param body the JSON-encoded {@link RunAgentInput}
     * @return an emitter that streams the agent's events as Server-Sent Events
     */
    @PostMapping(value = "${ag-ui.server.path:/agent}", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter runDefault(@RequestBody String body) {
        Agent agent = registry.single().orElseThrow(AgentNotFoundException::noSingleAgent);
        return stream(agent, body);
    }

    private SseEmitter stream(Agent agent, String body) {
        RunAgentInput input = serializer.deserialize(body, RunAgentInput.class);
        SseEmitter emitter = new SseEmitter(0L); // 0 => no timeout
        agent.run(input).subscribe(new EmitterSubscriber(emitter));
        return emitter;
    }

    /**
     * Relays an agent's event stream to an {@link SseEmitter}. Failures are
     * surfaced in band as a terminal {@code RUN_ERROR} frame, matching the
     * protocol rather than abruptly dropping the connection.
     */
    private final class EmitterSubscriber implements Flow.Subscriber<Event> {

        private final SseEmitter emitter;
        private Flow.Subscription subscription;

        EmitterSubscriber(SseEmitter emitter) {
            this.emitter = emitter;
        }

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            // SseEmitter.send blocks on the Servlet output, providing flow control.
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            try {
                emitter.send(SseEmitter.event().data(serializer.serialize(event)));
            } catch (IOException e) {
                // The client has gone away; stop pulling events from the agent.
                subscription.cancel();
                emitter.completeWithError(e);
            }
        }

        @Override
        public void onError(Throwable throwable) {
            try {
                emitter.send(SseEmitter.event().data(
                        serializer.serialize(new RunErrorEvent(describe(throwable)))));
            } catch (IOException | RuntimeException ignored) {
                // Nothing more we can do if the terminal frame cannot be delivered.
            }
            emitter.complete();
        }

        @Override
        public void onComplete() {
            emitter.complete();
        }
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
