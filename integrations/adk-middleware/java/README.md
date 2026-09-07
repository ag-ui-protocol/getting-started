# AG-UI middleware for Google ADK (Java)

This standalone Java 21 module adapts a Google Agent Development Kit (ADK) agent to the community Java `Agent` interface. It accepts `RunAgentInput`, manages ADK sessions, translates ADK events into AG-UI events, and exposes a cold `Flow.Publisher<Event>` suitable for the community Java server module.

Supported bridge behavior includes streaming text and reasoning, state snapshots/deltas, frontend and backend tool calls, message history snapshots, AG-UI interrupts and resumes, ADK confirmation requests, an optional application-owned auth adapter, and A2UI v0.9 payloads.

> **Hosting boundary:** this module is not a web framework or a ready-made application. HTTP routing, authentication, authorization, CORS, request-size limits, rate limits, TLS, and deployment topology remain the hosting application's responsibility.

## Documentation

- [Usage and executable server example](USAGE.md)
- [Configuration reference](CONFIGURATION.md)
- [Tool, HITL, auth, and A2UI behavior](TOOLS.md)
- [Architecture and lifecycle](ARCHITECTURE.md)
- [Logging](LOGGING.md)
- [Changelog](CHANGELOG.md)

## Requirements

- Java 21 or newer
- Maven 3.9 or newer
- Credentials accepted by the Google ADK/model configuration used by your application

Maven downloads Node.js locally only when this module's protocol tests run. A consuming application does not need Node.js for the middleware at runtime.

## Install locally

Build and install the current module in your local Maven repository:

```bash
mvn install
```

This installs `com.ag-ui.community:adk-middleware:0.1.0` in the local Maven repository. In another Maven project add:

```xml
<dependency>
  <groupId>com.ag-ui.community</groupId>
  <artifactId>adk-middleware</artifactId>
  <version>0.1.0</version>
</dependency>
```

The middleware already depends on `java-core`, `java-server`, Google ADK, RxJava, Jackson, and SLF4J API. Add an SLF4J provider in the application if logs are required.

## Minimal construction

The canonical entry point is `GoogleAdkAgent.fromApp(...)`:

```java
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

GoogleAdkAgent agent = GoogleAdkAgent.fromApp(
        app,
        input -> "authenticated-user-id",
        sessions,
        memory,
        artifacts,
        AdkAgUiOptions.defaults());
```

`input -> "authenticated-user-id"` is illustrative only. In a real service, derive the user ID from a verified server-side principal, not from untrusted request state or headers.

For the complete imports, JDK HTTP server wiring, build command, and a sample request, see [USAGE.md](USAGE.md).

## Build and test

```bash
mvn test
mvn package
```

The default test lifecycle runs Java tests plus Node-based AG-UI protocol tests. Live Vertex tests are excluded by default. See [Live Vertex smoke test](CONFIGURATION.md#live-vertex-smoke-test) for the explicit opt-in command and credentials.

## Production checklist

Before exposing an endpoint:

1. Authenticate the HTTP request and resolve a stable, tenant-scoped user ID server-side.
2. Authorize access to the requested `threadId`; a thread ID is not proof of ownership.
3. Enforce HTTP body, message, state, tool-count, tool-schema, and event-size limits outside this module. The bridge does not provide general payload/schema size limits.
4. Do not copy sensitive headers (for example `Authorization`, cookies, or API keys) into AG-UI state or model-visible metadata.
5. Replace process-local HITL/interrupt stores and thread-to-session mappings with shared, atomic implementations before running multiple replicas or requiring restart-safe resumes.
6. Use persistent ADK session/memory/artifact services where conversation durability is required.
7. Bound concurrency at the load balancer/application layer as well as with the process-local bridge limit.
8. Close `GoogleAdkAgent` during shutdown.

See [Known risks and deployment limits](ARCHITECTURE.md#known-risks-and-deployment-limits).
