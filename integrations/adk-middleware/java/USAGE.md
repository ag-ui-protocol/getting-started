# Usage

## Choose a construction path

`GoogleAdkAgent` implements `com.agui.community.core.agent.Agent` and `AutoCloseable`.

- Prefer `GoogleAdkAgent.fromApp(...)` when an ADK `App` is the composition root. The factory carries the app's root agent, plugins, and resumability setting into an ADK `Runner`.
- Use `GoogleAdkAgent.builder()` when the application already owns a `Runner`, needs a custom `AdkRunnerClient`, custom stores, explicit capabilities, auth handling, or other advanced seams.

Every subscription to `agent.run(input)` starts a run. Do not subscribe twice to a publisher expecting replay.

## Complete JDK server example

The following single-file application uses in-memory ADK services and the community Java server's JDK `HttpServer` adapter. It is executable after adding the middleware dependency described in [README.md](README.md).

```java
import com.agui.adk.AdkAgUiOptions;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.serialization.JacksonAgUiSerializer;
import com.agui.adk.tool.AgUiToolset;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.jdk.JdkAgentHttpHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.agents.LlmAgent;
import com.google.adk.apps.App;
import com.google.adk.artifacts.InMemoryArtifactService;
import com.google.adk.memory.InMemoryMemoryService;
import com.google.adk.sessions.InMemorySessionService;
import com.sun.net.httpserver.HttpServer;

import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

public final class Main {
    public static void main(String[] args) throws Exception {
        var sessions = new InMemorySessionService();
        var memory = new InMemoryMemoryService();
        var artifacts = new InMemoryArtifactService();

        var root = LlmAgent.builder()
                .name("assistant")
                .model("gemini-2.5-flash")
                .instruction("You are a helpful assistant.")
                .tools(new AgUiToolset())
                .build();

        var app = App.builder()
                .name("my-app")
                .rootAgent(root)
                .build();

        var agent = GoogleAdkAgent.fromApp(
                app,
                input -> "local-demo-user",
                sessions,
                memory,
                artifacts,
                AdkAgUiOptions.defaults());

        Serializer serializer = new JacksonAgUiSerializer(new ObjectMapper());
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/agent", new JdkAgentHttpHandler(agent, serializer));
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            agent.close();
        }));
        server.start();
        System.out.println("AG-UI endpoint: http://localhost:8080/agent");
    }
}
```

The model string and credentials must be valid for the Google ADK configuration in your environment. This example deliberately uses a fixed local user only to remain executable without choosing an HTTP authentication framework.

### Run it

Create a Maven application containing `src/main/java/Main.java` and the dependency from [README.md](README.md), then run it with your application's normal Maven execution setup. One generic option is:

```bash
mvn compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java -Dexec.mainClass=Main
```

The middleware module itself does **not** ship an example main class or configure the Exec plugin, so running `mvn exec:java` inside this directory is not an example-server command.

Send a valid AG-UI request:

```bash
curl -N http://localhost:8080/agent \
  -H 'content-type: application/json' \
  --data '{
    "threadId":"thread-1",
    "runId":"run-1",
    "state":{},
    "messages":[{"id":"message-1","role":"user","content":"Hello"}],
    "tools":[],
    "context":[],
    "forwardedProps":{},
    "resume":[]
  }'
```

The response is `text/event-stream`. The single-agent JDK handler also accepts `/agent/default`.

### What the JDK handler does not do

`JdkAgentHttpHandler` handles POST parsing and SSE streaming. It does not authenticate callers, authorize threads, extract headers into state, enforce CORS, or impose application payload/rate limits. Wrap it or use your application's transport adapter for production.

If pending frontend-tool events are persisted as pre-encoded JSON, advanced custom server wiring should use `PreEncodedSseEventEncoder` with an official `SseEventEncoder` so those bytes are preserved. The simple handler above uses its standard encoder; applications relying on exact pending-call replay should build `AgentRunHandler` with the middleware encoder.

## Builder construction

When the application owns the ADK runner:

```java
var runner = new Runner(rootAgent, "my-app", artifacts, sessions, memory);
var options = new AdkAgUiOptions(
        false,                 // generated ADK session IDs
        Duration.ofMinutes(10),
        10,                    // process-local accepted-run limit
        20,                    // tracked sessions per user; null means unlimited
        true,                  // emit end-of-run MESSAGES_SNAPSHOT
        true,                  // delete on cleanup
        true);                 // save to memory before deletion

var manager = new SessionManager(
        sessions,
        memory,
        new InMemoryThreadSessionMappingStore(),
        options);

var agent = GoogleAdkAgent.builder()
        .runner(new GoogleAdkRunnerClient(runner))
        .sessionManager(manager)
        .userIdExtractor(input -> authenticatedUserId(input))
        .configuredBackendToolNames(java.util.Set.of("lookup_order"))
        .options(options)
        .build();
```

`configuredBackendToolNames(...)` is mandatory on the builder, even when empty. Publish every backend tool name that can be visible so the bridge can reject frontend/backend name collisions. Opaque dynamic discovery is not performed.

The builder accepts either a static `userId(...)` or `userIdExtractor(...)`, never both. It similarly accepts `appName(...)` or `appNameExtractor(...)`; if neither app option is set, the runner's app name is used.

## Direct publisher use

A server adapter is optional:

```java
agent.run(input).subscribe(new Flow.Subscriber<>() {
    private Flow.Subscription subscription;

    @Override public void onSubscribe(Flow.Subscription value) {
        subscription = value;
        subscription.request(1);
    }

    @Override public void onNext(Event event) {
        try {
            System.out.println(event);
        } finally {
            subscription.request(1);
        }
    }

    @Override public void onError(Throwable error) {
        error.printStackTrace();
    }

    @Override public void onComplete() {
        System.out.println("complete");
    }
});
```

Cancellation propagates from the downstream subscription. The bridge also emits protocol `RUN_ERROR` events for expected run failures; consumers must handle both protocol events and publisher errors.

## Request state and context

`RunAgentInput.state` initializes/synchronizes ADK session state. The bridge reserves internal session keys; do not design application state around private `_ag_ui_*` or bridge-specific keys.

AG-UI `context` and `forwardedProps` are attached to request-scoped run metadata. A composition boundary may add metadata with `Builder.metadataEnricher(...)`, but may not replace the reserved bridge run-context key.

For headers, `HeaderExtraction.headerToKey("X-User-Id")` only normalizes a name to `user_id`; it does not read HTTP requests. The host must select headers, authenticate them, and merge safe values itself. Never forward secrets or raw credentials into state.

## Multiple agents

Use `AgentRegistry` and `JdkAgentHttpHandler(registry, serializer)` to route `/agent/{id}`. For a tool-result continuation, `AgentResolver.resolveAgentFromMessageHistory(...)` can recover the named agent that originated a tool call; it returns `null` when no safe match exists. Routing, registry access control, and tenant isolation remain application responsibilities.

## Shutdown

`GoogleAdkAgent.close()` cancels active runs, closes request resources, stops its session cleanup task, closes the runner, and closes managed services. It is idempotent. Register it with the host lifecycle; do not leave the agent alive across an application redeploy.
