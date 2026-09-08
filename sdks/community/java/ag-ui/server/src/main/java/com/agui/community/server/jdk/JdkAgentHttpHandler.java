package com.agui.community.server.jdk;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.serialization.SerializationException;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.server.AgentRunHandler;
import com.agui.community.server.EventSink;
import com.agui.community.server.OutputStreamEventSink;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletionException;

/**
 * An {@link HttpHandler} that exposes one or more {@link Agent}s over the AG-UI
 * protocol using only the JDK's built-in HTTP server
 * ({@code com.sun.net.httpserver}). It is the server-side mirror of the
 * JDK-based client and adds no third-party dependencies.
 *
 * <p>The handler accepts a {@code POST} whose JSON body is a
 * {@link RunAgentInput}, runs the addressed agent, and streams the resulting
 * events back as {@code text/event-stream}.
 *
 * <p><b>Routing.</b> Register the handler on a base context (for example
 * {@code /agent}); the path segment after it selects the agent by id
 * ({@code /agent/{id}}). When the registry holds exactly one agent, the bare
 * base path is also served as an alias. An unknown id yields
 * {@code 404 Not Found}. Malformed input is rejected with {@code 400 Bad
 * Request} before streaming begins; non-{@code POST} requests receive
 * {@code 405 Method Not Allowed}.
 *
 * <p><b>Body limit.</b> The two-argument constructors default to
 * {@value #DEFAULT_MAX_REQUEST_BODY_BYTES} bytes (8 MiB). Use a three-argument
 * constructor to override this limit. Bodies are counted before UTF-8 decoding;
 * oversized requests receive HTTP 413 without invoking the serializer or agent.
 * Previously accepted large requests may therefore be rejected by default.
 *
 * <pre>{@code
 * AgentRegistry registry = AgentRegistry.of(Map.of("weather", weatherAgent, "support", supportAgent));
 * HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
 * server.createContext("/agent", new JdkAgentHttpHandler(registry, serializer));
 * server.start();
 * // POST /agent/weather -> weatherAgent
 * }</pre>
 */
public final class JdkAgentHttpHandler implements HttpHandler {

    /** Default maximum request body size: 8 MiB, measured before UTF-8 decoding. */
    public static final int DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

    /** Id under which the single-agent convenience constructor registers its agent. */
    static final String DEFAULT_AGENT_ID = "default";

    private final AgentRegistry registry;
    private final Serializer serializer;
    private final int maxRequestBodyBytes;

    /**
     * Creates a handler that serves a single agent. It answers on the base path
     * (the alias) and on {@code {base}/default}.
     *
     * @param agent      the agent to run for each request (required)
     * @param serializer the serializer used to read input and encode events
     *                   (required)
     */
    public JdkAgentHttpHandler(Agent agent, Serializer serializer) {
        this(agent, serializer, DEFAULT_MAX_REQUEST_BODY_BYTES);
    }

    /**
     * Creates a single-agent handler with a request body limit in bytes.
     *
     * @param agent the agent to run (required)
     * @param serializer the serializer (required)
     * @param maxRequestBodyBytes maximum body size before UTF-8 decoding
     * @throws IllegalArgumentException if the limit is not between 1 and
     *         {@code Integer.MAX_VALUE - 1}, inclusive
     */
    public JdkAgentHttpHandler(Agent agent, Serializer serializer, int maxRequestBodyBytes) {
        this(AgentRegistry.of(Map.of(DEFAULT_AGENT_ID, Objects.requireNonNull(agent, "agent must not be null"))),
                serializer, maxRequestBodyBytes);
    }

    /**
     * Creates a handler that routes requests to one of several agents by the id
     * in the request path.
     *
     * @param registry   the agents addressable by this handler (required)
     * @param serializer the serializer used to read input and encode events
     *                   (required)
     */
    public JdkAgentHttpHandler(AgentRegistry registry, Serializer serializer) {
        this(registry, serializer, DEFAULT_MAX_REQUEST_BODY_BYTES);
    }

    /**
     * Creates a routing handler with a request body limit in bytes. Oversized
     * requests receive HTTP 413 without invoking the serializer or agent.
     *
     * @param registry the agents addressable by this handler (required)
     * @param serializer the serializer (required)
     * @param maxRequestBodyBytes maximum body size before UTF-8 decoding
     * @throws IllegalArgumentException if the limit is not between 1 and
     *         {@code Integer.MAX_VALUE - 1}, inclusive
     */
    public JdkAgentHttpHandler(AgentRegistry registry, Serializer serializer, int maxRequestBodyBytes) {
        this.registry = Objects.requireNonNull(registry, "registry must not be null");
        this.serializer = Objects.requireNonNull(serializer, "serializer must not be null");
        // Reserve one byte for detecting an oversized body without integer overflow.
        if (maxRequestBodyBytes <= 0 || maxRequestBodyBytes == Integer.MAX_VALUE) {
            throw new IllegalArgumentException("maxRequestBodyBytes must be between 1 and Integer.MAX_VALUE - 1");
        }
        this.maxRequestBodyBytes = maxRequestBodyBytes;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        try {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            Agent agent = resolveAgent(exchange);
            if (Objects.isNull(agent)) {
                exchange.sendResponseHeaders(404, -1);
                return;
            }
            AgentRunHandler handler = new AgentRunHandler(agent, serializer);

            String contentLength = exchange.getRequestHeaders().getFirst("Content-Length");
            if (contentLength != null) {
                try {
                    if (Long.parseLong(contentLength) > maxRequestBodyBytes) {
                        respondPlain(exchange, 413, "Request body too large");
                        return;
                    }
                } catch (NumberFormatException ignored) {
                    // The bounded read also protects requests with an invalid length.
                }
            }
            byte[] bytes = exchange.getRequestBody().readNBytes(maxRequestBodyBytes + 1);
            if (bytes.length > maxRequestBodyBytes) {
                respondPlain(exchange, 413, "Request body too large");
                return;
            }
            String body = new String(bytes, StandardCharsets.UTF_8);

            RunAgentInput input;
            try {
                input = handler.parse(body);
            } catch (SerializationException e) {
                respondPlain(exchange, 400, "Invalid AG-UI request: " + e.getMessage());
                return;
            }

            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.getResponseHeaders().add("Cache-Control", "no-cache");
            // 0 => response body of arbitrary length (chunked transfer encoding).
            exchange.sendResponseHeaders(200, 0);

            EventSink sink = new OutputStreamEventSink(exchange.getResponseBody());
            try {
                // Block until the agent's event stream has been fully relayed, so
                // the exchange is not closed mid-stream. Run failures are surfaced
                // in band as a RUN_ERROR frame, so completion is never exceptional.
                handler.run(input, sink).join();
            } catch (CompletionException ignored) {
                // Defensive: the response has already started, so there is nothing
                // left to signal beyond what was relayed in band.
            }
        } finally {
            exchange.close();
        }
    }

    /**
     * Resolves the addressed agent from the request path, or {@code null} if no
     * agent matches. The segment after the context path is the agent id; an
     * empty segment selects the single-agent alias.
     */
    private Agent resolveAgent(HttpExchange exchange) {
        String contextPath = exchange.getHttpContext().getPath();
        String path = exchange.getRequestURI().getPath();

        String id = path.length() > contextPath.length() ? path.substring(contextPath.length()) : "";
        if (id.startsWith("/")) {
            id = id.substring(1);
        }
        if (id.endsWith("/")) {
            id = id.substring(0, id.length() - 1);
        }

        return (id.isEmpty() ? registry.single() : registry.find(id)).orElse(null);
    }

    private static void respondPlain(HttpExchange exchange, int status, String message) throws IOException {
        byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
