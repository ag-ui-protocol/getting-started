package com.agui.community.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.CustomEvent;
import com.agui.community.core.event.Event;
import com.agui.community.core.serialization.Serializer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class HttpAgentTest {

    private HttpServer server;
    private URI endpoint;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        endpoint = URI.create("http://localhost:" + server.getAddress().getPort() + "/agent");
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    /** Responds with the given raw body and status, then closes the stream. */
    private void respondWith(int status, String body) {
        server.createContext("/agent", exchange -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(status, status >= 400 ? bytes.length : 0);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
    }

    @Test
    void emitsAnEventPerSseDataPayload() throws InterruptedException {
        respondWith(200, "data: alpha\n\ndata: beta\n\ndata: gamma\n\n");

        HttpAgent agent = new HttpAgent(endpoint, new EchoSerializer());
        CollectingSubscriber subscriber = new CollectingSubscriber();
        agent.run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(5, TimeUnit.SECONDS), "run did not complete in time");
        assertEquals(List.of("alpha", "beta", "gamma"), subscriber.payloads());
        assertNull(subscriber.error.get(), "run should complete without error");
    }

    @Test
    void completesWithNoEventsForEmptyStream() throws InterruptedException {
        respondWith(200, "");

        HttpAgent agent = new HttpAgent(endpoint, new EchoSerializer());
        CollectingSubscriber subscriber = new CollectingSubscriber();
        agent.run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(5, TimeUnit.SECONDS), "run did not complete in time");
        assertTrue(subscriber.payloads().isEmpty());
    }

    @Test
    void signalsErrorOnHttpErrorStatus() throws InterruptedException {
        respondWith(500, "boom");

        HttpAgent agent = new HttpAgent(endpoint, new EchoSerializer());
        CollectingSubscriber subscriber = new CollectingSubscriber();
        agent.run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(5, TimeUnit.SECONDS), "run did not terminate in time");
        Throwable error = subscriber.error.get();
        assertInstanceOf(HttpAgentException.class, error);
    }

    private static RunAgentInput sampleInput() {
        return new RunAgentInput("thread-1", "run-1", List.of(), List.of());
    }

    /** A serializer whose {@code deserialize} turns the SSE payload into a CustomEvent named after it. */
    private static final class EchoSerializer implements Serializer {
        @Override
        public String serialize(Object value) {
            return "{}";
        }

        @Override
        public <T> T deserialize(String json, Class<T> type) {
            return type.cast(new CustomEvent(json, json));
        }

        @Override
        public <T> List<T> deserializeList(String json, Class<T> elementType) {
            throw new UnsupportedOperationException();
        }
    }

    /** Collects emitted events and the terminal signal, releasing a latch on completion or error. */
    private static final class CollectingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new CopyOnWriteArrayList<>();
        private final AtomicReference<Throwable> error = new AtomicReference<>();
        private final CountDownLatch done = new CountDownLatch(1);

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event item) {
            events.add(item);
        }

        @Override
        public void onError(Throwable throwable) {
            error.set(throwable);
            done.countDown();
        }

        @Override
        public void onComplete() {
            done.countDown();
        }

        boolean awaitCompletion(long timeout, TimeUnit unit) throws InterruptedException {
            return done.await(timeout, unit);
        }

        List<String> payloads() {
            return events.stream().map(e -> ((CustomEvent) e).name()).toList();
        }
    }
}
