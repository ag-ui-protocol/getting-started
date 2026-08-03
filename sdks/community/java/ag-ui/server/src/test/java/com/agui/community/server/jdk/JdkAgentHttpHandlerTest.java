package com.agui.community.server.jdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.server.AgentRegistry;
import com.agui.community.server.FakeSerializer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.SubmissionPublisher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

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
