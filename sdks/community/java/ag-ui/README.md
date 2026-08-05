# ag-ui

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Java](https://img.shields.io/badge/Java-17%2B-orange.svg)](https://adoptium.net/)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=ag-ui-4j_ag-ui&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ag-ui-4j_ag-ui)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=ag-ui-4j_ag-ui&metric=coverage)](https://sonarcloud.io/summary/new_code?id=ag-ui-4j_ag-ui)

A modular Java library for the [**AG-UI protocol**](https://docs.ag-ui.com) — the
open, event-based protocol for connecting AI agents to user-facing applications.

It models the protocol as a stream of typed **events** (text, tool calls,
reasoning, state deltas, lifecycle) that an [`Agent`](core/src/main/java/com/agui/community/core/agent/Agent.java)
emits in response to a `RunAgentInput`. The streaming type is the JDK's built-in
`java.util.concurrent.Flow.Publisher`, so the core has **no third-party runtime
dependencies**.

## Modules

| Module | Description |
|--------|-------------|
| [`core`](core) | Core types and protocol primitives — messages, events, agent abstraction, and a pluggable `Serializer`. No external runtime dependencies. |
| [`client`](client) | Client implementation. `HttpAgent` runs against a remote AG-UI endpoint over HTTP, decoding the Server-Sent Events response into a stream of events. Built on the JDK `HttpClient`. |
| [`server`](server) | Server-side support for exposing an `Agent` over the AG-UI protocol. |

## Requirements

- **Java 17+**
- **Maven 3.8+**

## Building

```bash
mvn clean install
```

Run the tests only:

```bash
mvn test
```

## Usage

### Connecting to a remote agent (client)

`HttpAgent` POSTs a `RunAgentInput` to an AG-UI endpoint and exposes the
Server-Sent Events response as a `Flow.Publisher<Event>`. You supply a
`Serializer` (the library is agnostic to the concrete JSON implementation).

```java
import com.agui.community.client.HttpAgent;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;

import java.net.URI;
import java.util.concurrent.Flow;

Serializer serializer = /* your Serializer implementation */;

Agent agent = new HttpAgent(
        URI.create("https://example.com/agent"),
        serializer);

RunAgentInput input = /* build the run input: messages, tools, context, state */;

agent.run(input).subscribe(new Flow.Subscriber<>() {
    @Override public void onSubscribe(Flow.Subscription s) { s.request(Long.MAX_VALUE); }
    @Override public void onNext(Event event)              { System.out.println(event); }
    @Override public void onError(Throwable t)             { t.printStackTrace(); }
    @Override public void onComplete()                     { System.out.println("done"); }
});
```

Each subscription triggers a fresh run: the request is sent on subscribe, events
are emitted in order, and the publisher completes when the stream ends (or
signals `onError` on failure).

### Implementing an agent

`Agent` is a functional interface — implement `run` to emit your own event
stream:

```java
Agent agent = input -> {
    // produce a Flow.Publisher<Event> describing the run
};
```

## Using as a dependency

Artifacts are published under the `com.ag-ui.community` group id. Add the modules
you need:

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>java-client</artifactId>
    <version>0.2.0</version>
</dependency>
```

> `core` is brought in transitively by `client` and `server`; depend on it
> directly if you only need the protocol types.

## Contributing

Contributions are welcome! Please read the organization's
[Contributing Guide](https://github.com/ag-ui-4j/.github/blob/main/CONTRIBUTING.md)
and [Code of Conduct](https://github.com/ag-ui-4j/.github/blob/main/CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
