package com.agui.community.server.jdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

import com.sun.net.httpserver.HttpServer;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.server.AgentRegistry;
import com.agui.community.server.FakeSerializer;
import com.agui.community.core.serialization.Serializer;
import java.io.ByteArrayInputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpPrincipal;
import java.net.Socket;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.SubmissionPublisher;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

class JdkAgentHttpHandlerTest {

    private static final RunAgentInput INPUT = new RunAgentInput("t1", "r1", List.of(), List.of());

    private HttpServer server;
    private URI endpoint;
    private final AtomicReference<String> requestContentLength = new AtomicReference<>();
    private final AtomicReference<String> requestTransferEncoding = new AtomicReference<>();

    @BeforeEach
    void startServer() throws Exception {
        server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        endpoint = URI.create("http://localhost:" + server.getAddress().getPort() + "/agent");
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void streamsAgentEventsAsServerSentEvents() throws Exception {
        Agent agent = input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.submit(new RunStartedEvent("t1", "r1"));
            publisher.submit(new TextMessageContentEvent("m1", "hi"));
            publisher.submit(new RunFinishedEvent("t1", "r1"));
            publisher.close();
        };
        register(new JdkAgentHttpHandler(agent, FakeSerializer.returning(INPUT)));

        HttpResponse<String> response = post("{}");

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type").orElse("").contains("text/event-stream"));
        assertEquals(
                "data: RUN_STARTED\n\ndata: TEXT_MESSAGE_CONTENT\n\ndata: RUN_FINISHED\n\n",
                response.body());
    }

    @Test
    void rejectsMalformedInputWithBadRequest() throws Exception {
        register(new JdkAgentHttpHandler(input -> subscriber -> { }, FakeSerializer.failingDeserialize()));

        HttpResponse<String> response = post("not json");

        assertEquals(400, response.statusCode());
    }

    @Test
    void rejectsNonPostWithMethodNotAllowed() throws Exception {
        register(new JdkAgentHttpHandler(input -> subscriber -> { }, FakeSerializer.returning(INPUT)));

        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(endpoint).GET().build(),
                HttpResponse.BodyHandlers.ofString());

        assertEquals(405, response.statusCode());
    }

    @Test
    void routesToAgentByIdInPath() throws Exception {
        // Distinct event types let FakeSerializer (which encodes type()) tell the agents apart.
        Agent weather = agentEmitting(new RunStartedEvent("t1", "r1"));
        Agent support = agentEmitting(new RunFinishedEvent("t1", "r1"));
        server.createContext("/agent", new JdkAgentHttpHandler(
                AgentRegistry.of(Map.of("weather", weather, "support", support)),
                FakeSerializer.returning(INPUT)));
        server.start();

        assertEquals("data: RUN_STARTED\n\n", postTo("/agent/weather", "{}").body());
        assertEquals("data: RUN_FINISHED\n\n", postTo("/agent/support", "{}").body());
    }

    @Test
    void unknownAgentIdReturnsNotFound() throws Exception {
        server.createContext("/agent", new JdkAgentHttpHandler(
                AgentRegistry.of(Map.of("weather", agentEmitting(new RunStartedEvent("t1", "r1")))),
                FakeSerializer.returning(INPUT)));
        server.start();

        assertEquals(404, postTo("/agent/missing", "{}").statusCode());
    }

    @ParameterizedTest
    @CsvSource({"7, false", "8, false", "9, false", "7, true", "8, true", "9, true"})
    void enforcesByteLimitWithFixedLengthAndChunkedBodies(int size, boolean chunked) throws Exception {
        RecordingSerializer serializer = new RecordingSerializer();
        AtomicInteger runs = new AtomicInteger();
        register(new JdkAgentHttpHandler(recordingAgent(runs), serializer, 8));
        String body = " ".repeat(size - 2) + "{}";

        HttpResponse<String> response = postBody(body, chunked);

        boolean accepted = size <= 8;
        assertEquals(accepted ? 200 : 413, response.statusCode());
        assertEquals(accepted ? 1 : 0, serializer.reads.get());
        assertEquals(accepted ? 1 : 0, serializer.writes.get());
        assertEquals(accepted ? 1 : 0, runs.get());
        if (accepted) {
            assertEquals(body, serializer.body.get());
        }
    }

    @ParameterizedTest
    @CsvSource({"9, false", "10, false", "9, true", "10, true"})
    void countsMultibyteUtf8BeforeDecoding(int limit, boolean chunked) throws Exception {
        RecordingSerializer serializer = new RecordingSerializer();
        AtomicInteger runs = new AtomicInteger();
        register(new JdkAgentHttpHandler(recordingAgent(runs), serializer, limit));
        String body = "[\"你😀\"]";
        assertEquals(11, body.getBytes(StandardCharsets.UTF_8).length);

        HttpResponse<String> response = postBody(body, chunked);

        assertEquals(413, response.statusCode());
        assertEquals(0, serializer.reads.get());
        assertEquals(0, serializer.writes.get());
        assertEquals(0, runs.get());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void preservesMultibyteTextAtExactLimit(boolean chunked) throws Exception {
        RecordingSerializer serializer = new RecordingSerializer();
        AtomicInteger runs = new AtomicInteger();
        register(new JdkAgentHttpHandler(recordingAgent(runs), serializer, 11));
        String body = "[\"你😀\"]";

        assertEquals(200, postBody(body, chunked).statusCode());
        assertEquals(body, serializer.body.get());
        assertEquals(1, runs.get());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void existingConstructorsApplyDefaultLimit(boolean registryConstructor) throws Exception {
        RecordingSerializer serializer = new RecordingSerializer();
        AtomicInteger runs = new AtomicInteger();
        Agent agent = recordingAgent(runs);
        register(registryConstructor
                ? new JdkAgentHttpHandler(AgentRegistry.of(Map.of("test", agent)), serializer)
                : new JdkAgentHttpHandler(agent, serializer));
        // Send only headers: a response proves rejection precedes any body read.
        try (Socket socket = new Socket("localhost", server.getAddress().getPort())) {
            socket.setSoTimeout(5000);
            String headers = "POST /agent HTTP/1.1\r\nHost: localhost\r\nContent-Length: "
                    + ((long) JdkAgentHttpHandler.DEFAULT_MAX_REQUEST_BODY_BYTES + 1)
                    + "\r\nConnection: close\r\n\r\n";
            socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();
            String status = new BufferedReader(new InputStreamReader(
                    socket.getInputStream(), StandardCharsets.US_ASCII)).readLine();
            assertTrue(status.startsWith("HTTP/1.1 413"), status);
        }
        assertEquals(0, serializer.reads.get());
        assertEquals(0, serializer.writes.get());
        assertEquals(0, runs.get());
    }

    @ParameterizedTest
    @ValueSource(ints = {Integer.MIN_VALUE, -1, 0, Integer.MAX_VALUE})
    void rejectsInvalidLimits(int limit) {
        Agent agent = agentEmitting(new RunFinishedEvent("t1", "r1"));
        Serializer serializer = FakeSerializer.returning(INPUT);
        assertThrows(IllegalArgumentException.class, () -> new JdkAgentHttpHandler(agent, serializer, limit));
        assertThrows(IllegalArgumentException.class, () -> new JdkAgentHttpHandler(
                AgentRegistry.of(Map.of("test", agent)), serializer, limit));
    }

    @ParameterizedTest
    @ValueSource(ints = {1, Integer.MAX_VALUE - 1})
    void acceptsValidLimitExtremes(int limit) {
        Agent agent = agentEmitting(new RunFinishedEvent("t1", "r1"));
        Serializer serializer = FakeSerializer.returning(INPUT);
        assertDoesNotThrow(() -> new JdkAgentHttpHandler(agent, serializer, limit));
        assertDoesNotThrow(() -> new JdkAgentHttpHandler(
                AgentRegistry.of(Map.of("test", agent)), serializer, limit));
    }

    @Test
    void boundedReadDoesNotTrustUnderstatedContentLength() throws Exception {
        RecordingSerializer serializer = new RecordingSerializer();
        AtomicInteger runs = new AtomicInteger();
        AtomicInteger bytesRead = new AtomicInteger();
        JdkAgentHttpHandler handler = new JdkAgentHttpHandler(recordingAgent(runs), serializer, 8);
        HttpContext context = server.createContext("/agent", handler);
        Headers headers = new Headers();
        headers.set("Content-Length", "1");
        AtomicInteger status = new AtomicInteger();
        InputStream body = new ByteArrayInputStream(new byte[100]) {
            @Override
            public synchronized int read(byte[] buffer, int offset, int length) {
                int count = super.read(buffer, offset, length);
                if (count > 0) {
                    bytesRead.addAndGet(count);
                }
                return count;
            }
        };
        // A test exchange can expose a misleading length independently of the
        // real HTTP server's framing rules and immutable request headers.
        HttpExchange exchange = new HttpExchange() {
            private final Headers responseHeaders = new Headers();
            private final OutputStream responseBody = new ByteArrayOutputStream();
            @Override public Headers getRequestHeaders() { return headers; }
            @Override public Headers getResponseHeaders() { return responseHeaders; }
            @Override public URI getRequestURI() { return endpoint; }
            @Override public String getRequestMethod() { return "POST"; }
            @Override public HttpContext getHttpContext() { return context; }
            @Override public void close() { }
            @Override public InputStream getRequestBody() { return body; }
            @Override public OutputStream getResponseBody() { return responseBody; }
            @Override public void sendResponseHeaders(int code, long length) { status.set(code); }
            @Override public InetSocketAddress getRemoteAddress() { return null; }
            @Override public int getResponseCode() { return status.get(); }
            @Override public InetSocketAddress getLocalAddress() { return server.getAddress(); }
            @Override public String getProtocol() { return "HTTP/1.1"; }
            @Override public Object getAttribute(String name) { return null; }
            @Override public void setAttribute(String name, Object value) { }
            @Override public void setStreams(InputStream input, OutputStream output) { }
            @Override public HttpPrincipal getPrincipal() { return null; }
        };

        handler.handle(exchange);

        assertEquals(413, status.get());
        assertEquals(9, bytesRead.get());
        assertEquals(0, serializer.reads.get());
        assertEquals(0, serializer.writes.get());
        assertEquals(0, runs.get());
    }

    private static Agent recordingAgent(AtomicInteger runs) {
        return input -> {
            runs.incrementAndGet();
            return agentEmitting(new RunFinishedEvent("t1", "r1")).run(input);
        };
    }

    private HttpResponse<String> postBody(String body, boolean chunked) throws Exception {
        HttpRequest.BodyPublisher publisher = chunked
                ? HttpRequest.BodyPublishers.ofInputStream(
                        () -> new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)))
                : HttpRequest.BodyPublishers.ofString(body);
        assertEquals(chunked ? -1 : body.getBytes(StandardCharsets.UTF_8).length, publisher.contentLength());
        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5))
                        .header("Content-Type", "application/json").POST(publisher).build(),
                HttpResponse.BodyHandlers.ofString());
        if (chunked) {
            assertEquals(null, requestContentLength.get());
            assertEquals("chunked", requestTransferEncoding.get());
        }
        return response;
    }

    private static final class RecordingSerializer implements Serializer {
        final AtomicInteger reads = new AtomicInteger();
        final AtomicInteger writes = new AtomicInteger();
        final AtomicReference<String> body = new AtomicReference<>();

        @Override
        public String serialize(Object value) {
            writes.incrementAndGet();
            return ((Event) value).type().value();
        }

        @Override
        public <T> T deserialize(String json, Class<T> type) {
            reads.incrementAndGet();
            body.set(json);
            return type.cast(INPUT);
        }

        @Override
        public <T> List<T> deserializeList(String json, Class<T> type) {
            reads.incrementAndGet();
            throw new AssertionError("Unexpected deserializeList");
        }
    }

    private static Agent agentEmitting(Event event) {
        return input -> subscriber -> {
            SubmissionPublisher<Event> publisher = new SubmissionPublisher<>();
            publisher.subscribe(subscriber);
            publisher.submit(event);
            publisher.close();
        };
    }

    private void register(JdkAgentHttpHandler handler) {
        server.createContext("/agent", exchange -> {
            requestContentLength.set(exchange.getRequestHeaders().getFirst("Content-Length"));
            requestTransferEncoding.set(exchange.getRequestHeaders().getFirst("Transfer-Encoding"));
            handler.handle(exchange);
        });
        server.start();
    }

    private HttpResponse<String> postTo(String path, String body) throws Exception {
        URI uri = URI.create("http://localhost:" + server.getAddress().getPort() + path);
        return HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(uri)
                        .timeout(Duration.ofSeconds(5))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String body) throws Exception {
        return HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(endpoint)
                        .timeout(Duration.ofSeconds(5))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }
}
