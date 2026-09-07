package com.agui.community.server.jdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpPrincipal;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.server.FakeSerializer;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.SubmissionPublisher;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class JdkAgentHttpHandlerTest {

    private static final RunAgentInput INPUT = new RunAgentInput("t1", "r1", List.of(), List.of());

    private HttpServer server;
    private URI endpoint;

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
    @ValueSource(booleans = {false, true})
    void rejectsOversizedRequestBeforeRunningAgent(boolean chunked) throws Exception {
        AtomicBoolean invoked = new AtomicBoolean();
        Agent agent = input -> {
            invoked.set(true);
            return agentEmitting(new RunFinishedEvent("t1", "r1")).run(input);
        };
        register(new JdkAgentHttpHandler(agent, FakeSerializer.returning(INPUT)));
        byte[] body = new byte[8 * 1024 * 1024 + 1];
        HttpRequest.BodyPublisher publisher = chunked
                ? HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(body))
                : HttpRequest.BodyPublishers.ofByteArray(body);

        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5)).POST(publisher).build(),
                HttpResponse.BodyHandlers.ofString());

        assertEquals(413, response.statusCode());
        assertEquals(false, invoked.get());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void customLimitAcceptsBoundaryAndRejectsOneByteOverBeforeParsingOrRunning(boolean chunked) throws Exception {
        int maxRequestBodyBytes = 16;
        AtomicInteger invocations = new AtomicInteger();
        CountingSerializer serializer = new CountingSerializer(FakeSerializer.returning(INPUT));
        Agent agent = input -> {
            invocations.incrementAndGet();
            return agentEmitting(new RunFinishedEvent("t1", "r1")).run(input);
        };
        register(new JdkAgentHttpHandler(agent, serializer, maxRequestBodyBytes));

        HttpResponse<String> boundary = post(bodyOfLength(maxRequestBodyBytes), chunked);
        HttpResponse<String> oversized = post(bodyOfLength(maxRequestBodyBytes + 1), chunked);

        assertEquals(200, boundary.statusCode());
        assertEquals(413, oversized.statusCode());
        assertEquals(1, serializer.deserializeCalls());
        assertEquals(1, invocations.get());
    }

    @Test
    void rejectsNonPositiveCustomLimits() {
        Agent agent = input -> subscriber -> { };
        Serializer serializer = FakeSerializer.returning(INPUT);
        AgentRegistry registry = AgentRegistry.of(Map.of("default", agent));

        assertThrows(IllegalArgumentException.class, () -> new JdkAgentHttpHandler(agent, serializer, 0));
        assertThrows(IllegalArgumentException.class, () -> new JdkAgentHttpHandler(agent, serializer, -1));
        assertThrows(IllegalArgumentException.class, () -> new JdkAgentHttpHandler(registry, serializer, 0));
        assertThrows(IllegalArgumentException.class, () -> new JdkAgentHttpHandler(registry, serializer, -1));
    }

    @Test
    void oversizedDirectExchangeReadsOnlyOneBytePastLimitBeforeRejecting() throws Exception {
        int maxRequestBodyBytes = 4;
        CountingInputStream requestBody = new CountingInputStream(bodyOfLength(maxRequestBodyBytes + 10));
        CountingSerializer serializer = new CountingSerializer(FakeSerializer.returning(INPUT));
        AtomicBoolean invoked = new AtomicBoolean();
        JdkAgentHttpHandler handler = new JdkAgentHttpHandler(input -> {
            invoked.set(true);
            return agentEmitting(new RunFinishedEvent("t1", "r1")).run(input);
        }, serializer, maxRequestBodyBytes);
        TestExchange exchange = new TestExchange(requestBody);

        handler.handle(exchange);

        assertEquals(413, exchange.statusCode());
        assertEquals(maxRequestBodyBytes + 1, requestBody.bytesRead());
        assertEquals(0, serializer.deserializeCalls());
        assertEquals(false, invoked.get());
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
        server.createContext("/agent", handler);
        server.start();
    }

    private HttpResponse<String> post(String body, boolean chunked) throws Exception {
        HttpRequest.BodyPublisher publisher = chunked
                ? HttpRequest.BodyPublishers.ofInputStream(() -> new ByteArrayInputStream(body.getBytes()))
                : HttpRequest.BodyPublishers.ofString(body);
        return HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(endpoint)
                        .timeout(Duration.ofSeconds(5))
                        .header("Content-Type", "application/json")
                        .POST(publisher)
                        .build(),
                HttpResponse.BodyHandlers.ofString());
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

    private static String bodyOfLength(int length) {
        return "x".repeat(length);
    }

    private static final class CountingSerializer implements Serializer {

        private final Serializer delegate;
        private int deserializeCalls;

        private CountingSerializer(Serializer delegate) {
            this.delegate = delegate;
        }

        @Override
        public String serialize(Object value) {
            return delegate.serialize(value);
        }

        @Override
        public <T> T deserialize(String json, Class<T> type) {
            deserializeCalls++;
            return delegate.deserialize(json, type);
        }

        @Override
        public <T> List<T> deserializeList(String json, Class<T> elementType) {
            return delegate.deserializeList(json, elementType);
        }

        private int deserializeCalls() {
            return deserializeCalls;
        }
    }

    private static final class CountingInputStream extends InputStream {

        private final byte[] bytes;
        private int position;

        private CountingInputStream(String body) {
            this.bytes = body.getBytes();
        }

        @Override
        public int read() {
            if (position == bytes.length) {
                return -1;
            }
            return bytes[position++];
        }

        @Override
        public int read(byte[] buffer, int offset, int length) {
            if (position == bytes.length) {
                return -1;
            }
            int count = Math.min(length, bytes.length - position);
            System.arraycopy(bytes, position, buffer, offset, count);
            position += count;
            return count;
        }

        private int bytesRead() {
            return position;
        }
    }

    private static final class TestExchange extends HttpExchange {

        private final InputStream requestBody;
        private final ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        private final com.sun.net.httpserver.Headers responseHeaders = new com.sun.net.httpserver.Headers();
        private final TestHttpContext context = new TestHttpContext();
        private int statusCode;

        private TestExchange(InputStream requestBody) {
            this.requestBody = requestBody;
        }

        @Override
        public com.sun.net.httpserver.Headers getRequestHeaders() {
            return new com.sun.net.httpserver.Headers();
        }

        @Override
        public com.sun.net.httpserver.Headers getResponseHeaders() {
            return responseHeaders;
        }

        @Override
        public URI getRequestURI() {
            return URI.create("http://localhost/agent");
        }

        @Override
        public String getRequestMethod() {
            return "POST";
        }

        @Override
        public HttpContext getHttpContext() {
            return context;
        }

        @Override
        public void close() {
        }

        @Override
        public InputStream getRequestBody() {
            return requestBody;
        }

        @Override
        public OutputStream getResponseBody() {
            return responseBody;
        }

        @Override
        public void sendResponseHeaders(int responseCode, long responseLength) {
            this.statusCode = responseCode;
        }

        @Override
        public InetSocketAddress getRemoteAddress() {
            return new InetSocketAddress("localhost", 0);
        }

        @Override
        public int getResponseCode() {
            return statusCode;
        }

        @Override
        public InetSocketAddress getLocalAddress() {
            return new InetSocketAddress("localhost", 0);
        }

        @Override
        public String getProtocol() {
            return "HTTP/1.1";
        }

        @Override
        public Object getAttribute(String name) {
            return null;
        }

        @Override
        public void setAttribute(String name, Object value) {
        }

        @Override
        public void setStreams(InputStream input, OutputStream output) {
        }

        @Override
        public HttpPrincipal getPrincipal() {
            return null;
        }

        private int statusCode() {
            return statusCode;
        }
    }

    private static final class TestHttpContext extends HttpContext {

        @Override
        public HttpHandler getHandler() {
            return null;
        }

        @Override
        public void setHandler(HttpHandler handler) {
        }

        @Override
        public String getPath() {
            return "/agent";
        }

        @Override
        public HttpServer getServer() {
            return null;
        }

        @Override
        public Map<String, Object> getAttributes() {
            return new HashMap<>();
        }

        @Override
        public List<com.sun.net.httpserver.Filter> getFilters() {
            return Collections.emptyList();
        }

        @Override
        public com.sun.net.httpserver.Authenticator setAuthenticator(
                com.sun.net.httpserver.Authenticator authenticator) {
            return authenticator;
        }

        @Override
        public com.sun.net.httpserver.Authenticator getAuthenticator() {
            return null;
        }
    }
}
