# ag-ui-spring · spring-webflux-server


Spring WebFlux server integration for the [AG-UI protocol](https://docs.ag-ui.com).

It exposes an `Agent`
as a reactive `text/event-stream` endpoint and provides the Jackson-based
`Serializer` the protocol needs. It is wire-compatible with the `HttpAgent`
client and is the Spring counterpart to the JDK handler in the `ag-ui` `server`
module.

> Servlet-based app? Use [`ag-ui-spring-webmvc-server`](../spring-webmvc-server)
> instead — same API, backed by an `SseEmitter`.

## What's inside

| Type | Purpose |
|------|---------|
| [`AgUiController`](src/main/java/com/agui/community/spring/server/AgUiController.java) | WebFlux `@RestController` that accepts a `RunAgentInput` POST and streams the agent's events as Server-Sent Events. Routes `/agent/{id}` to an agent from an `AgentRegistry` (single-agent alias on the base path; unknown id → `404`). Base path defaults to `/agent` (override with `ag-ui.server.path`). |
| [`AgUiServerAutoConfiguration`](src/main/java/com/agui/community/spring/server/AgUiServerAutoConfiguration.java) | Spring Boot auto-configuration: contributes a `Serializer` (reusing the app's `ObjectMapper`), a default `AgentRegistry` keyed by **bean name** from all `Agent` beans, and the controller. |

The Jackson-backed `Serializer` (`JacksonSerializer`) and `AgentNotFoundException`
come from [`spring-server-core`](../spring-server-core), shared with the WebMVC server.

## Usage

Define an `Agent` bean; the endpoint is auto-configured:

```java
@Configuration
class AgUiConfig {
    @Bean
    Agent agent() {
        return input -> subscriber -> { /* emit events */ };
    }
}
```

`POST /agent` with a JSON `RunAgentInput` now streams the agent's events as SSE.
Malformed input is rejected with `400 Bad Request`; run failures are surfaced in
band as a terminal `RUN_ERROR` event.

### Multiple agents

Define several `Agent` beans; each is reachable at `/agent/{beanName}`, and an
unknown id returns `404`:

```java
@Bean Agent weather() { … }   // POST /agent/weather
@Bean Agent support() { … }   // POST /agent/support
```

With exactly one agent, the bare `/agent` path still works (alias). To use ids
other than bean names, define your own `AgentRegistry` bean — it overrides the
default:

```java
@Bean
AgentRegistry agents(Agent weather, Agent support) {
    return AgentRegistry.of(Map.of("weather", weather, "support", support));
}
```

### Wiring manually (without auto-configuration)

```java
Serializer serializer = new JacksonSerializer(objectMapper);
AgUiController controller = new AgUiController(AgentRegistry.of(Map.of("chat", agent)), serializer);
```

## Notes

- The `JacksonSerializer` round-trips correctly between this library's client and
  server. Full byte-for-byte parity with the reference TypeScript/Python
  implementations (exact optional-field naming, etc.) may need further mapping
  configuration.

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>ag-ui-spring-webflux-server</artifactId>
    <version>4.1.0</version>
</dependency>
```

> This module is versioned independently and tracks the **Spring Boot 3.4.x**
> line it targets. See the [root README](../README.md) for the project overview.
