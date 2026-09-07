package com.agui.adk;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.agui.adk.serialization.JacksonAgUiSerializer;
import com.agui.community.server.jdk.JdkAgentHttpHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.LlmAgent;
import com.google.adk.apps.App;
import com.google.adk.models.BaseLlm;
import com.google.adk.models.LlmRequest;
import com.google.adk.models.LlmResponse;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.sessions.InMemorySessionService;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.sun.net.httpserver.HttpServer;
import io.reactivex.rxjava3.core.Flowable;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Real-HTTP integration test: starts a real {@link HttpServer} backed by the
 * {@link JdkAgentHttpHandler}, posts a real {@code RunAgentInput} JSON body,
 * and asserts the complete SSE round-trip (RUN_STARTED, text content,
 * RUN_FINISHED) — no external LLM credentials required (model is stubbed).
 */
class RealHttpRoundTripIntegrationTest {

    private static final String RESPONSE_TEXT = "Hello from the Java ADK middleware!";

    private BaseLlm model;
    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws Exception {
        model = mock(BaseLlm.class);
        when(model.model()).thenReturn("stub-model");
        LlmResponse response = LlmResponse.builder()
                .content(Content.builder()
                        .role("model")
                        .parts(List.of(Part.builder().text(RESPONSE_TEXT).build()))
                        .build())
                .build();
        when(model.generateContent(any(LlmRequest.class), eq(true))).thenReturn(Flowable.just(response));
        when(model.generateContent(any(LlmRequest.class), eq(false))).thenReturn(Flowable.just(response));

        LlmAgent root = LlmAgent.builder()
                .name("assistant")
                .model(model)
                .instruction("You are a stub assistant.")
                .build();
        App app = App.builder().name("real_http_demo").rootAgent(root).build();
        GoogleAdkAgent agent = GoogleAdkAgent.fromApp(
                app,
                ignored -> "user",
                new InMemorySessionService(),
                new InMemoryMemoryService(),
                new InMemoryArtifactService(),
                AdkAgUiOptions.defaults());

        JacksonAgUiSerializer serializer = new JacksonAgUiSerializer(new ObjectMapper());
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/chat", new JdkAgentHttpHandler(agent, serializer));
        server.start();
        port = server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void realHttpRoundTripStreamsTextAndFinishes() throws Exception {
        String body = """
                {"threadId":"t1","runId":"r1","state":{},"messages":[{"id":"m1","role":"user","content":"hello"}],"tools":[],"context":[],"forwardedProps":{}}
                """;

        HttpURLConnection connection = post(body);

        assertThat(connection.getResponseCode()).isEqualTo(200);
        assertThat(connection.getHeaderField("Content-Type")).contains("text/event-stream");

        String frames = readSse(connection);
        assertThat(frames).contains("RUN_STARTED");
        assertThat(frames).contains("TEXT_MESSAGE_CONTENT");
        assertThat(frames).contains(RESPONSE_TEXT);
        assertThat(frames).contains("RUN_FINISHED");
    }

    @Test
    void realHttpRoundTripStreamsFrontendToolCallAndFinishes() throws Exception {
        LlmResponse toolCallResponse = LlmResponse.builder()
                .content(Content.builder()
                        .role("model")
                        .parts(List.of(Part.builder()
                                .functionCall(FunctionCall.builder()
                                        .id("call-dashboard")
                                        .name("propose_dashboard")
                                        .args(Map.of("title", "Sales"))
                                        .build())
                                .build()))
                        .build())
                .build();
        LlmResponse finalResponse = LlmResponse.builder()
                .content(Content.builder()
                        .role("model")
                        .parts(List.of(Part.builder().text(RESPONSE_TEXT).build()))
                        .build())
                .build();
        when(model.generateContent(any(LlmRequest.class), eq(true)))
                .thenReturn(Flowable.just(toolCallResponse), Flowable.just(finalResponse));
        when(model.generateContent(any(LlmRequest.class), eq(false)))
                .thenReturn(Flowable.just(toolCallResponse), Flowable.just(finalResponse));

        String body = """
                {"threadId":"tools-thread","runId":"tools-run","state":{},"messages":[{"id":"tools-message","role":"user","content":"build a dashboard"}],"tools":[{"name":"propose_dashboard","description":"Propose a dashboard","parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}],"context":[],"forwardedProps":{}}
                """;

        HttpURLConnection connection = post(body);

        assertThat(connection.getResponseCode()).isEqualTo(200);
        assertThat(connection.getHeaderField("Content-Type")).contains("text/event-stream");

        String frames = readSse(connection);
        assertThat(frames).contains("RUN_STARTED");
        assertThat(frames).contains(
                "\"type\":\"TOOL_CALL_CHUNK\"",
                "\"toolCallId\":\"call-dashboard\"",
                "\"toolCallName\":\"propose_dashboard\"",
                "\"delta\":\"{\\\"title\\\":\\\"Sales\\\"}\"");
        assertThat(frames).contains("RUN_FINISHED");
        assertThat(frames).doesNotContain("RUN_ERROR", "ENCODING_ERROR");
    }

    private HttpURLConnection post(String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) URI.create(
                "http://127.0.0.1:" + port + "/chat").toURL().openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "text/event-stream");
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        return connection;
    }

    private String readSse(HttpURLConnection connection) throws IOException {
        StringBuilder sse = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sse.append(line).append('\n');
            }
        }
        return sse.toString();
    }
}
