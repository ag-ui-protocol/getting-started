# ag-ui · client

Client implementation for the [AG-UI protocol](https://docs.ag-ui.com).

This module lets you talk to a remote AG-UI endpoint as an
[`Agent`](../core/src/main/java/com/agui/community/core/agent/Agent.java). It is
built only on the JDK's `HttpClient` and an injected `Serializer`, so it stays
agnostic to the concrete JSON library you use.

## What's inside

| Type                                                                                    | Purpose                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`HttpAgent`](src/main/java/com/agui/community/client/HttpAgent.java)                   | An `Agent` that serializes a `RunAgentInput` to JSON, POSTs it to a remote endpoint, and decodes the Server-Sent Events response into a `Flow.Publisher<Event>`. |
| [`SseLimits`](src/main/java/com/agui/community/client/SseLimits.java)                   | Positive per-line and per-event byte caps for an SSE response. Defaults are 1 MiB per line and 8 MiB per event data payload.                                     |
| [`SseEventParser`](src/main/java/com/agui/community/client/SseEventParser.java)         | Parses a Server-Sent Events byte/line stream into AG-UI events.                                                                                                  |
| [`HttpAgentException`](src/main/java/com/agui/community/client/HttpAgentException.java) | Raised (via `onError`) when a request fails or returns an error status.                                                                                          |

## Usage

```java
import com.agui.community.client.HttpAgent;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;

import java.net.URI;
import java.util.concurrent.Flow;

Serializer serializer = /* your Serializer implementation */;

Agent agent = new HttpAgent(URI.create("https://example.com/agent"), serializer);

RunAgentInput input = /* messages, tools, context, state */;

agent.run(input).subscribe(new Flow.Subscriber<>() {
    @Override public void onSubscribe(Flow.Subscription s) { s.request(Long.MAX_VALUE); }
    @Override public void onNext(Event event)              { System.out.println(event); }
    @Override public void onError(Throwable t)             { t.printStackTrace(); }
    @Override public void onComplete()                     { System.out.println("done"); }
});
```

Each subscription triggers a fresh run: the request is sent on subscribe, events
are emitted in order, and the publisher completes when the stream ends.

### Customizing the transport

The default constructor uses `HttpClient.newHttpClient()`, a cached thread pool
for stream processing, a 5-minute request timeout, and `SseLimits.DEFAULT`.
`SseLimits.DEFAULT` allows up to 1 MiB per SSE line and 8 MiB per decoded event
`data` payload.

Use the `SseLimits` overload when you only need custom response limits:

```java
Agent agent = new HttpAgent(
        URI.create("https://example.com/agent"),
        serializer,
        new SseLimits(256 * 1024, 2 * 1024 * 1024));
```

Use the full constructor to control the `HttpClient`, the `Executor` on which
the response stream is consumed, the per-request timeout, and the SSE limits:

```java
Agent agent = new HttpAgent(
        URI.create("https://example.com/agent"),
        serializer,
        myHttpClient,
        myExecutor,
        Duration.ofSeconds(30),
        new SseLimits(256 * 1024, 2 * 1024 * 1024));
```

Both limits count UTF-8 bytes, not Java characters. The line limit excludes the
CR/LF terminator, but applies to every wire line, including comments and fields
that the AG-UI client ignores. The event limit applies to the combined decoded
`data` payload, including the newline bytes inserted between multiple `data:`
fields. These caps are per line and per event; there is no lifetime byte budget
for a long-running stream.

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>java-client</artifactId>
    <version>0.2.0</version>
</dependency>
```

Pulls in [`core`](../core) transitively. See the [root README](../README.md)
for the project overview.
