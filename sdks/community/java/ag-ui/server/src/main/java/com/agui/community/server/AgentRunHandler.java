package com.agui.community.server;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.serialization.Serializer;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

/**
 * The transport-neutral heart of the AG-UI server: it parses a request body into
 * a {@link RunAgentInput}, runs an {@link Agent}, and relays the resulting
 * {@link com.agui.community.core.event.Event} stream to an {@link EventSink},
 * framing each event through an {@link EventEncoder}.
 *
 * <p>This class knows nothing about HTTP or the wire protocol. A transport
 * adapter is responsible for reading the request body, supplying an
 * {@link EventSink} over its response, and choosing how to report a parse failure
 * (typically HTTP 400). The {@link EventEncoder} decides the framing: by default
 * Server-Sent Events, but a WebSocket adapter can inject a different encoder
 * without touching this class. Separating {@link #parse(String)} from
 * {@link #run(RunAgentInput, EventSink)} lets an adapter reject malformed input
 * <em>before</em> it begins streaming a 200 response.
 */
public final class AgentRunHandler {

    private final Agent agent;
    private final Serializer serializer;
    private final EventEncoder encoder;

    /**
     * Creates a handler that frames events as Server-Sent Events.
     *
     * @param agent      the agent to run for each request (required)
     * @param serializer the serializer used to read input and encode events
     *                   (required)
     */
    public AgentRunHandler(Agent agent, Serializer serializer) {
        this(agent, serializer, new SseEventEncoder(Objects.requireNonNull(serializer, "serializer must not be null")));
    }

    /**
     * Creates a handler that frames events through the given encoder, allowing a
     * transport other than SSE (for example WebSocket) to choose its own framing.
     * The serializer is still used to parse the request body.
     *
     * @param agent      the agent to run for each request (required)
     * @param serializer the serializer used to read input (required)
     * @param encoder    the encoder used to frame each event (required)
     */
    public AgentRunHandler(Agent agent, Serializer serializer, EventEncoder encoder) {
        this.agent = Objects.requireNonNull(agent, "agent must not be null");
        this.serializer = Objects.requireNonNull(serializer, "serializer must not be null");
        this.encoder = Objects.requireNonNull(encoder, "encoder must not be null");
    }

    /**
     * Parses a request body into a {@link RunAgentInput}.
     *
     * @param requestBody the JSON request body (required)
     * @return the parsed run input
     * @throws com.agui.community.core.serialization.SerializationException if the
     *         body is not valid AG-UI input
     */
    public RunAgentInput parse(String requestBody) {
        Objects.requireNonNull(requestBody, "requestBody must not be null");
        return serializer.deserialize(requestBody, RunAgentInput.class);
    }

    /**
     * Runs the agent for the given input, relaying its events to the sink as
     * encoded frames. Run failures are surfaced in band as a terminal
     * {@link com.agui.community.core.event.RunErrorEvent} frame.
     *
     * @param input the run input (required)
     * @param sink  the destination for encoded frames (required)
     * @return a future that completes when the stream has fully terminated and
     *         the transport may close its response
     */
    public CompletableFuture<Void> run(RunAgentInput input, EventSink sink) {
        Objects.requireNonNull(input, "input must not be null");
        Objects.requireNonNull(sink, "sink must not be null");
        EventRelaySubscriber subscriber = new EventRelaySubscriber(sink, encoder);
        agent.run(input).subscribe(subscriber);
        return subscriber.completion();
    }
}
