# ag-ui · server

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=ag-ui-4j_ag-ui&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ag-ui-4j_ag-ui)

Server-side support for the [AG-UI protocol](https://docs.ag-ui.com).

This module exposes an [`Agent`](../core/src/main/java/com/agui/community/core/agent/Agent.java)
over the protocol: it reads a `RunAgentInput`, runs the agent, and streams the
resulting `Event`s back to the client as Server-Sent Events. It is the
server-side mirror of the [`client`](../client) module's `HttpAgent`.

The core is **transport-neutral** and free of any HTTP framework. Wire framing is
isolated behind an `EventEncoder`, so the same core can serve Server-Sent Events
today and another protocol (such as WebSocket) later by swapping the encoder. A
single JDK-based SSE adapter is included so you can run a real endpoint with no
third-party dependencies.

## What's inside

### Transport-neutral core (`com.agui.community.server`)

| Type | Purpose |
|------|---------|
| [`AgentRunHandler`](src/main/java/com/agui/community/server/AgentRunHandler.java) | Parses a request body into a `RunAgentInput`, runs the `Agent`, and relays its events to an `EventSink`, framing each through an `EventEncoder`. Knows nothing about HTTP or the wire protocol. |
| [`AgentRegistry`](src/main/java/com/agui/community/server/AgentRegistry.java) | A lookup from agent id to `Agent`, so a transport can route `/agent/{id}` to one of several agents. `single()` exposes the sole agent when exactly one is registered. |
| [`EventEncoder`](src/main/java/com/agui/community/server/EventEncoder.java) | Frames an `Event` for a particular protocol — the single point of variation between SSE and a future transport such as WebSocket. |
| [`EventSink`](src/main/java/com/agui/community/server/EventSink.java) | A transport-neutral destination for already-encoded frames; an adapter implements it over its response. |
| [`SseEventEncoder`](src/main/java/com/agui/community/server/SseEventEncoder.java) | The SSE `EventEncoder`: encodes an `Event` as a `data:` frame using the injected `Serializer`. |
| [`EventRelaySubscriber`](src/main/java/com/agui/community/server/EventRelaySubscriber.java) | A `Flow.Subscriber<Event>` that writes encoded frames to the sink, requesting one event at a time for backpressure, and surfaces failures in band as a terminal `RUN_ERROR` frame. |
| [`OutputStreamEventSink`](src/main/java/com/agui/community/server/OutputStreamEventSink.java) | An `EventSink` over a blocking `OutputStream` (flushes per frame). |

### JDK transport (`com.agui.community.server.jdk`)

| Type | Purpose |
|------|---------|
| [`JdkAgentHttpHandler`](src/main/java/com/agui/community/server/jdk/JdkAgentHttpHandler.java) | An `HttpHandler` for the JDK's built-in `com.sun.net.httpserver`. Routes `/agent/{id}` to an agent from an `AgentRegistry` (single-agent alias on the base path), streams events as `text/event-stream`, and rejects unknown ids with `404`, malformed input with `400`, and non-`POST` with `405`. No third-party dependencies. |

## Usage

```java
import com.sun.net.httpserver.HttpServer;
import com.agui.community.core.agent.Agent;
import com.agui.community.server.jdk.JdkAgentHttpHandler;

import java.net.InetSocketAddress;

Agent agent = /* your Agent */;
Serializer serializer = /* your Serializer implementation */;

HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
server.createContext("/agent", new JdkAgentHttpHandler(agent, serializer));
server.start();
```

Point the [`HttpAgent`](../client) client at `http://localhost:8080/agent` to
drive it.

### Multiple agents

Pass an [`AgentRegistry`](src/main/java/com/agui/community/server/AgentRegistry.java)
to address several agents by the id in the path (`/agent/{id}`). An unknown id
returns `404`:

```java
AgentRegistry registry = AgentRegistry.of(Map.of(
        "weather", weatherAgent,
        "support", supportAgent));

server.createContext("/agent", new JdkAgentHttpHandler(registry, serializer));
// POST /agent/weather -> weatherAgent, POST /agent/support -> supportAgent
```

The single-agent constructor above is shorthand for a one-entry registry: it is
served on the base path (the alias) and on `/agent/default`.

### Bringing your own transport

To integrate with another stack (servlet, WebFlux, …), use the transport-neutral
core directly: build an `AgentRunHandler`, implement `EventSink` over your
response, then `parse` the body (mapping failures to `400`) and `run`:

```java
AgentRunHandler handler = new AgentRunHandler(agent, serializer);

RunAgentInput input = handler.parse(requestBody);   // throws on bad input -> 400
handler.run(input, myEventSink).join();             // completes when the stream ends
```

To serve a different wire protocol (for example WebSocket message frames rather
than SSE `data:` frames), supply your own `EventEncoder` — the rest of the core
is unchanged:

```java
EventEncoder encoder = event -> serializer.serialize(event); // bare JSON per message
AgentRunHandler handler = new AgentRunHandler(agent, serializer, encoder);
```

> A Spring (WebFlux / Spring Boot starter) adapter and a Spring AI integration
> live in a separate `ag-ui-spring` repository, to keep this module
> dependency-free.

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>java-server</artifactId>
    <version>0.2.0</version>
</dependency>
```

Pulls in [`core`](../core) transitively. See the [root README](../README.md)
for the project overview.
