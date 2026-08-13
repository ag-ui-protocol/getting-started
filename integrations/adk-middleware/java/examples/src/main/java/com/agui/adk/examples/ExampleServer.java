package com.agui.adk.examples;

import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.serialization.JacksonAgUiSerializer;
import com.agui.adk.tool.AgUiToolset;
import com.agui.community.server.jdk.JdkAgentHttpHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.LlmAgent;
import com.google.adk.apps.App;
import com.google.adk.apps.ResumabilityConfig;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.sessions.InMemorySessionService;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/** Executable, dependency-light AG-UI SSE server mirroring the supported Python Dojo examples. */
public final class ExampleServer {
    private static final String MODEL = "gemini-2.5-flash";
    private static final String USER_ID = "demo_user";

    private ExampleServer() {}

    public static void main(String[] args) throws IOException {
        String host = environment("HOST", "0.0.0.0");
        int port = parsePort(environment("PORT", "8000"));

        Map<String, GoogleAdkAgent> agents = new LinkedHashMap<>();
        agents.put("/chat", chatAgent());
        agents.put("/adk-human-in-loop-agent", humanInTheLoopAgent());
        agents.put("/adk-agentic-generative-ui", agenticGenerativeUiAgent());

        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
        JacksonAgUiSerializer serializer = new JacksonAgUiSerializer(new ObjectMapper());
        agents.forEach((path, agent) -> server.createContext(path, new JdkAgentHttpHandler(agent, serializer)));
        server.createContext("/", exchange -> index(exchange, agents.keySet().stream().toList()));
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            agents.values().forEach(GoogleAdkAgent::close);
        }));
        server.start();

        System.out.printf("Java ADK example server listening on http://%s:%d%n", host, port);
        agents.keySet().forEach(path -> System.out.printf("  POST http://localhost:%d%s%n", port, path));
    }

    private static GoogleAdkAgent chatAgent() {
        LlmAgent root = LlmAgent.builder()
                .name("assistant")
                .model(MODEL)
                .instruction("""
                        You are a helpful conversational assistant. Greet greetings with "Hello".
                        Use earlier conversation context when it answers the user's question.
                        Request-defined AG-UI frontend tools are available when useful.
                        """)
                .tools(new AgUiToolset())
                .build();
        return bridge(App.builder().name("java_chat_demo").rootAgent(root).build());
    }

    private static GoogleAdkAgent humanInTheLoopAgent() {
        LlmAgent root = LlmAgent.builder()
                .name("human_in_loop_agent")
                .model(MODEL)
                .instruction("""
                        You are a human-in-the-loop task planning assistant.
                        For an actual task request, call the request-defined frontend tool
                        `generate_task_steps`. Generate the requested number of concise imperative
                        steps, defaulting to ten, each with status `enabled`. Do not call it for
                        greetings. After the human returns the tool result, execute only enabled
                        steps, one per line ending in an ellipsis, then confirm completion. Treat
                        disabled steps as permanently removed and never mention them.
                        """)
                .tools(new AgUiToolset(List.of("generate_task_steps"), null))
                .build();
        App app = App.builder()
                .name("java_hitl_demo")
                .rootAgent(root)
                .resumabilityConfig(ResumabilityConfig.builder().resumable(true).build())
                .build();
        return bridge(app);
    }

    private static GoogleAdkAgent agenticGenerativeUiAgent() {
        LlmAgent root = LlmAgent.builder()
                .name("planner")
                .model(MODEL)
                .instruction("""
                        Plan using request-defined frontend tools only, without other messages.
                        Call `create_plan` once with the initial step descriptions. Then call
                        `update_plan_step` for every step until all are completed. Do not repeat,
                        summarize, or confirm the plan in text. Only one plan may be active.
                        """)
                .tools(new AgUiToolset(List.of("create_plan", "update_plan_step"), null))
                .build();
        return bridge(App.builder().name("java_agentic_generative_ui_demo").rootAgent(root).build());
    }

    private static GoogleAdkAgent bridge(App app) {
        return GoogleAdkAgent.fromApp(
                app,
                ignored -> USER_ID,
                new InMemorySessionService(),
                new InMemoryMemoryService(),
                new InMemoryArtifactService(),
                AdkAgUiOptions.defaults());
    }

    private static void index(HttpExchange exchange, List<String> paths) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }
        String body = "Java ADK middleware example server\n" + String.join("\n", paths) + "\n";
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        exchange.sendResponseHeaders(200, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }

    private static String environment(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static int parsePort(String value) {
        try {
            int port = Integer.parseInt(value);
            if (port < 1 || port > 65_535) throw new NumberFormatException();
            return port;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("PORT must be an integer from 1 to 65535: " + value, exception);
        }
    }
}
