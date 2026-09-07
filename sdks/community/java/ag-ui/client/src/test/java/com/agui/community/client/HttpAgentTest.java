package com.agui.community.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.CustomEvent;
import com.agui.community.core.event.Event;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

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

    @Test
    void closesResponseBodyAndSignalsErrorOnHttpErrorStatus() throws InterruptedException {
        CloseObservingInputStream body = new CloseObservingInputStream("boom");
        CollectingSubscriber subscriber = new CollectingSubscriber();

        newStubbedAgent(new EchoSerializer(), 500, body, SseLimits.DEFAULT).run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(1, TimeUnit.SECONDS));
        assertInstanceOf(HttpAgentException.class, subscriber.error.get());
        assertTrue(body.closed());
    }

    @ParameterizedTest
    @ValueSource(strings = {"data: ", ": ", "unknown: ", "id: ", "event: "})
    void rejectsOversizedLinesIncludingIgnoredFields(String prefix) throws InterruptedException {
        respondWith(200, prefix + "x".repeat(1024 * 1024));
        CollectingSubscriber subscriber = new CollectingSubscriber();
        CountingSerializer serializer = new CountingSerializer();

        new HttpAgent(endpoint, serializer).run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(5, TimeUnit.SECONDS));
        assertInstanceOf(HttpAgentException.class, subscriber.error.get());
        assertTrue(subscriber.events.isEmpty(), "oversized data must not be decoded");
        assertEquals(0, serializer.deserializeCalls());
    }

    @Test
    void closesResponseBodyAndSignalsErrorOnLineLimitFailure() throws InterruptedException {
        CloseObservingInputStream body = new CloseObservingInputStream("data: 123456789\n");
        CountingSerializer serializer = new CountingSerializer();
        CollectingSubscriber subscriber = new CollectingSubscriber();

        newStubbedAgent(serializer, 200, body, new SseLimits(8, 1024)).run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(1, TimeUnit.SECONDS));
        assertInstanceOf(HttpAgentException.class, subscriber.error.get());
        assertTrue(body.closed());
        assertEquals(0, serializer.deserializeCalls());
    }

    @Test
    void closesResponseBodyAndSignalsErrorOnEventLimitFailure() throws InterruptedException {
        CloseObservingInputStream body = new CloseObservingInputStream("data: 1234\ndata: 5678\n\n");
        CountingSerializer serializer = new CountingSerializer();
        CollectingSubscriber subscriber = new CollectingSubscriber();

        newStubbedAgent(serializer, 200, body, new SseLimits(1024, 8)).run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(1, TimeUnit.SECONDS));
        assertInstanceOf(HttpAgentException.class, subscriber.error.get());
        assertTrue(body.closed());
        assertEquals(0, serializer.deserializeCalls());
    }

    @Test
    void closesResponseBodyAndSignalsOrdinarySerializerException() throws InterruptedException {
        CloseObservingInputStream body = new CloseObservingInputStream("data: {}\n\n");
        RuntimeException failure = new IllegalArgumentException("bad event");
        Serializer serializer = new EchoSerializer() {
            @Override
            public <T> T deserialize(String json, Class<T> type) {
                throw failure;
            }
        };
        CollectingSubscriber subscriber = new CollectingSubscriber();

        newStubbedAgent(serializer, 200, body, SseLimits.DEFAULT).run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(1, TimeUnit.SECONDS));
        assertEquals(failure, subscriber.error.get());
        assertTrue(body.closed());
    }

    @Test
    void signalsSerializerStackOverflowAsSerializationFailure() throws InterruptedException {
        CloseObservingInputStream body = new CloseObservingInputStream("data: {}\n\n");
        StackOverflowError failure = new StackOverflowError("injected parser overflow");
        Serializer serializer = new EchoSerializer() {
            @Override
            public <T> T deserialize(String json, Class<T> type) {
                throw failure;
            }
        };
        CollectingSubscriber subscriber = new CollectingSubscriber();

        newStubbedAgent(serializer, 200, body, SseLimits.DEFAULT).run(sampleInput()).subscribe(subscriber);

        assertTrue(subscriber.awaitCompletion(5, TimeUnit.SECONDS), "subscriber was left unterminated");
        SerializationException error = assertInstanceOf(SerializationException.class, subscriber.error.get());
        assertEquals(failure, error.getCause());
        assertTrue(body.closed());
    }

    @Test
    void restoresInterruptStatusWhenHttpSendIsInterrupted() {
        Thread.interrupted();
        InterruptedException failure = new InterruptedException("interrupted send");
        CollectingSubscriber subscriber = new CollectingSubscriber();

        try {
            HttpAgent agent = new HttpAgent(endpoint, new EchoSerializer(), new StubHttpClient(failure),
                    Runnable::run, Duration.ofSeconds(1), SseLimits.DEFAULT);

            agent.run(sampleInput()).subscribe(subscriber);

            assertEquals(failure, subscriber.error.get());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    private static RunAgentInput sampleInput() {
        return new RunAgentInput("thread-1", "run-1", List.of(), List.of());
    }

    /** A serializer whose {@code deserialize} turns the SSE payload into a CustomEvent named after it. */
    private static class EchoSerializer implements Serializer {
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

    private static final class CountingSerializer extends EchoSerializer {
        private final AtomicInteger deserializeCalls = new AtomicInteger();

        @Override
        public <T> T deserialize(String json, Class<T> type) {
            deserializeCalls.incrementAndGet();
            return super.deserialize(json, type);
        }

        private int deserializeCalls() {
            return deserializeCalls.get();
        }
    }

    private HttpAgent newStubbedAgent(Serializer serializer, int statusCode, InputStream body, SseLimits limits) {
        return new HttpAgent(endpoint, serializer, new StubHttpClient(new StubHttpResponse(statusCode, body)),
                Runnable::run, Duration.ofSeconds(1), limits);
    }

    private static final class CloseObservingInputStream extends InputStream {
        private final ByteArrayInputStream delegate;
        private boolean closed;

        private CloseObservingInputStream(String body) {
            this.delegate = new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public int read() {
            return delegate.read();
        }

        @Override
        public void close() throws IOException {
            closed = true;
            delegate.close();
        }

        private boolean closed() {
            return closed;
        }
    }

    private static final class StubHttpClient extends HttpClient {
        private final HttpResponse<InputStream> response;
        private final InterruptedException interruption;

        private StubHttpClient(HttpResponse<InputStream> response) {
            this.response = response;
            this.interruption = null;
        }

        private StubHttpClient(InterruptedException interruption) {
            this.response = null;
            this.interruption = interruption;
        }

        @Override
        public Optional<CookieHandler> cookieHandler() {
            return Optional.empty();
        }

        @Override
        public Optional<Duration> connectTimeout() {
            return Optional.empty();
        }

        @Override
        public Redirect followRedirects() {
            return Redirect.NEVER;
        }

        @Override
        public Optional<ProxySelector> proxy() {
            return Optional.empty();
        }

        @Override
        public SSLContext sslContext() {
            return null;
        }

        @Override
        public SSLParameters sslParameters() {
            return null;
        }

        @Override
        public Optional<Authenticator> authenticator() {
            return Optional.empty();
        }

        @Override
        public Version version() {
            return Version.HTTP_1_1;
        }

        @Override
        public Optional<java.util.concurrent.Executor> executor() {
            return Optional.empty();
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler)
                throws IOException, InterruptedException {
            if (interruption != null) {
                throw interruption;
            }
            return (HttpResponse<T>) response;
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
                                                                HttpResponse.BodyHandler<T> responseBodyHandler) {
            throw new UnsupportedOperationException();
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
                                                                HttpResponse.BodyHandler<T> responseBodyHandler,
                                                                HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
            throw new UnsupportedOperationException();
        }
    }

    private static final class StubHttpResponse implements HttpResponse<InputStream> {
        private final int statusCode;
        private final InputStream body;

        private StubHttpResponse(int statusCode, InputStream body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        @Override
        public int statusCode() {
            return statusCode;
        }

        @Override
        public HttpRequest request() {
            return null;
        }

        @Override
        public Optional<HttpResponse<InputStream>> previousResponse() {
            return Optional.empty();
        }

        @Override
        public HttpHeaders headers() {
            return HttpHeaders.of(Map.of(), (name, value) -> true);
        }

        @Override
        public InputStream body() {
            return body;
        }

        @Override
        public Optional<SSLSession> sslSession() {
            return Optional.empty();
        }

        @Override
        public URI uri() {
            return URI.create("http://localhost/agent");
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_1_1;
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
