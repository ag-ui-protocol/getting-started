package com.agui.community.server;

import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import java.io.IOException;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;

/**
 * A {@link Flow.Subscriber} that relays an agent's {@link Event} stream to an
 * {@link EventSink}, framing each event through an {@link EventEncoder}. It
 * requests one event at a time, so a slow client naturally backpressures the
 * agent through the reactive subscription.
 *
 * <p>The subscriber is protocol-neutral: SSE versus WebSocket framing is decided
 * entirely by the injected {@link EventEncoder}.
 *
 * <p>The subscriber surfaces failures <em>in band</em>: if the agent signals
 * {@code onError}, a terminal {@link RunErrorEvent} frame is written before the
 * sink is closed, matching the AG-UI protocol rather than abruptly dropping the
 * connection. A {@link #completion()} future completes when the stream has fully
 * terminated, so a transport adapter knows when it is safe to close the
 * response.
 */
public final class EventRelaySubscriber implements Flow.Subscriber<Event> {

    private final EventSink sink;
    private final EventEncoder encoder;
    private final CompletableFuture<Void> completion = new CompletableFuture<>();

    private Flow.Subscription subscription;

    /**
     * Creates a relay that writes encoded events to the given sink.
     *
     * @param sink    the destination for encoded frames (required)
     * @param encoder the encoder used to frame events (required)
     */
    public EventRelaySubscriber(EventSink sink, EventEncoder encoder) {
        this.sink = Objects.requireNonNull(sink, "sink must not be null");
        this.encoder = Objects.requireNonNull(encoder, "encoder must not be null");
    }

    /**
     * @return a future that completes when the relayed stream has terminated
     *         (normally, on error, or on client disconnect)
     */
    public CompletableFuture<Void> completion() {
        return completion;
    }

    @Override
    public void onSubscribe(Flow.Subscription subscription) {
        this.subscription = subscription;
        subscription.request(1);
    }

    @Override
    public void onNext(Event event) {
        try {
            sink.write(encoder.encode(event));
        } catch (IOException e) {
            // The client has gone away; stop pulling events from the agent.
            subscription.cancel();
            finish();
            return;
        }
        subscription.request(1);
    }

    @Override
    public void onError(Throwable throwable) {
        try {
            sink.write(encoder.encode(new RunErrorEvent(describe(throwable))));
        } catch (IOException | RuntimeException ignored) {
            // Nothing more we can do if the terminal frame cannot be delivered.
        }
        finish();
    }

    @Override
    public void onComplete() {
        finish();
    }

    private void finish() {
        try {
            sink.close();
        } catch (IOException ignored) {
            // The stream is already terminating; a failed close is not actionable.
        }
        completion.complete(null);
    }

    private static String describe(Throwable throwable) {
        String message = throwable.getMessage();
        return Objects.nonNull(message) ? message : throwable.getClass().getSimpleName();
    }
}
