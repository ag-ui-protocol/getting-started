package com.agui.community.client;

import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.serialization.Serializer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.SubmissionPublisher;
import java.util.stream.Stream;

/**
 * An {@link Agent} that runs against a remote AG-UI endpoint over HTTP. It
 * serializes the {@link RunAgentInput} as JSON, POSTs it to the configured
 * endpoint, and decodes the Server-Sent Events response into a stream of
 * {@link Event}s.
 *
 * <p>This client depends only on the JDK's {@link HttpClient} and an injected
 * {@link Serializer}; it is agnostic to the concrete JSON library used.
 *
 * <p>Each subscription to the returned publisher triggers a fresh run: the
 * request is sent when a subscriber subscribes, events are emitted in order, and
 * the publisher completes when the stream ends or signals {@code onError} if the
 * request fails or returns an error status.
 */
public final class HttpAgent implements Agent {

    private static final Duration DEFAULT_REQUEST_TIMEOUT = Duration.ofMinutes(5);

    /**
     * Shared executor used by the {@linkplain #HttpAgent(URI, Serializer) default
     * constructor}. Consuming an SSE response is a long-lived blocking operation,
     * so running it on a bounded pool shared across the JVM (such as
     * {@code ForkJoinPool.commonPool()}) risks starving that pool — a burst of
     * concurrent runs could occupy every worker and deadlock. A cached thread
     * pool sidesteps this: it creates threads on demand (reusing idle ones) and
     * is effectively unbounded, so a blocking stream read never starves other
     * runs.
     */
    private static final Executor DEFAULT_EXECUTOR = Executors.newCachedThreadPool();

    private final URI endpoint;
    private final Serializer serializer;
    private final HttpClient httpClient;
    private final Executor executor;
    private final Duration requestTimeout;

    /**
     * Creates an agent using a default {@link HttpClient} and a cached thread
     * pool for stream processing.
     *
     * @param endpoint   the URI of the remote AG-UI endpoint
     * @param serializer the serializer used to encode the input and decode events
     */
    public HttpAgent(URI endpoint, Serializer serializer) {
        this(endpoint, serializer, HttpClient.newHttpClient(), DEFAULT_EXECUTOR,
                DEFAULT_REQUEST_TIMEOUT);
    }

    /**
     * Creates an agent with full control over the HTTP client, executor and
     * request timeout.
     *
     * @param endpoint       the URI of the remote AG-UI endpoint
     * @param serializer     the serializer used to encode the input and decode
     *                       events
     * @param httpClient     the HTTP client to use
     * @param executor       the executor on which the (blocking) response stream
     *                       is consumed and events are published
     * @param requestTimeout the per-request timeout
     */
    public HttpAgent(URI endpoint, Serializer serializer, HttpClient httpClient, Executor executor,
                     Duration requestTimeout) {
        this.endpoint = Objects.requireNonNull(endpoint, "endpoint must not be null");
        this.serializer = Objects.requireNonNull(serializer, "serializer must not be null");
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient must not be null");
        this.executor = Objects.requireNonNull(executor, "executor must not be null");
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout must not be null");
    }

    @Override
    public Flow.Publisher<Event> run(RunAgentInput input) {
        Objects.requireNonNull(input, "input must not be null");
        return subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>(executor, Flow.defaultBufferSize());
            publisher.subscribe(subscriber);
            executor.execute(() -> stream(input, publisher));
        };
    }

    private void stream(RunAgentInput input, SubmissionPublisher<Event> publisher) {
        try {
            HttpRequest request = HttpRequest.newBuilder(endpoint)
                    .timeout(requestTimeout)
                    .header("Content-Type", "application/json")
                    .header("Accept", "text/event-stream")
                    .POST(HttpRequest.BodyPublishers.ofString(serializer.serialize(input)))
                    .build();

            HttpResponse<Stream<String>> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.ofLines());

            if (response.statusCode() >= 400) {
                publisher.closeExceptionally(new HttpAgentException(
                        "AG-UI endpoint returned HTTP " + response.statusCode()));
                return;
            }

            SseEventParser parser = new SseEventParser();
            try (Stream<String> lines = response.body()) {
                lines.forEach(line ->
                        parser.feed(line).ifPresent(data -> publisher.submit(decode(data))));
            }
            parser.flush().ifPresent(data -> publisher.submit(decode(data)));
            publisher.close();
        } catch (InterruptedException e) {
            // Restore the interrupt status before surfacing the failure, so callers
            // up the stack can still observe that this thread was interrupted.
            Thread.currentThread().interrupt();
            publisher.closeExceptionally(e);
        } catch (Exception e) {
            publisher.closeExceptionally(e);
        }
    }

    private Event decode(String data) {
        return serializer.deserialize(data, Event.class);
    }
}
