# ag-ui-spring · spring-webmvc-server


Spring **WebMVC** (Servlet) server integration for the [AG-UI protocol](https://docs.ag-ui.com).

It exposes an `Agent`
as a `text/event-stream` endpoint using an `SseEmitter`, and provides the
Jackson-based `Serializer` the protocol needs. It is the Servlet counterpart to
[`ag-ui-spring-webflux-server`](../spring-webflux-server) — pick this module if
your application is Servlet-based (`spring-boot-starter-web`) rather than
reactive. Both are wire-compatible with the `HttpAgent` client.

## What's inside

| Type | Purpose |
|------|---------|
| [`AgUiController`](src/main/java/com/agui/community/spring/webmvc/AgUiController.java) | WebMVC `@RestController` that accepts a `RunAgentInput` POST and streams the agent's events as Server-Sent Events via an `SseEmitter`. Routes `/agent/{id}` to an agent from an `AgentRegistry` (single-agent alias on the base path; unknown id → `404`). Base path defaults to `/agent` (override with `ag-ui.server.path`). |
| [`AgUiServerAutoConfiguration`](src/main/java/com/agui/community/spring/webmvc/AgUiServerAutoConfiguration.java) | Spring Boot auto-configuration (active only in a **Servlet** web app): contributes a `Serializer`, a default `AgentRegistry` keyed by **bean name** from all `Agent` beans, and the controller. |

The Jackson-backed `Serializer` (`JacksonSerializer`) and `AgentNotFoundException`
come from [`spring-server-core`](../spring-server-core), shared with the WebFlux server.

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
unknown id returns `404`. With exactly one agent, the bare `/agent` path still
works (alias). To use ids other than bean names, define your own `AgentRegistry`
bean — it overrides the default:

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

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>ag-ui-spring-webmvc-server</artifactId>
    <version>4.1.0</version>
</dependency>
```

> This module is versioned independently and tracks the **Spring Boot 3.4.x**
> line it targets. See the [root README](../README.md) for the project overview.
