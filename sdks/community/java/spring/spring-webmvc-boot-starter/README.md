# ag-ui-spring · spring-webmvc-boot-starter


Spring Boot starter that exposes an AG-UI
`Agent`
over a Servlet (**WebMVC**) HTTP Server-Sent Events endpoint.

Add this single dependency and define one `Agent` bean — auto-configuration
(from [`ag-ui-spring-webmvc-server`](../spring-webmvc-server)) wires a `Serializer`
and the `SseEmitter`-backed `/agent` endpoint around it. For a reactive (WebFlux)
app, use [`ag-ui-spring-webflux-boot-starter`](../spring-webflux-boot-starter)
instead.

## Usage

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>ag-ui-spring-webmvc-boot-starter</artifactId>
    <version>4.1.0</version>
</dependency>
```

```java
@Bean
Agent agent() {
    return input -> subscriber -> { /* emit events */ };
}
```

`POST /agent` with a JSON `RunAgentInput` now streams the agent's events as SSE.
Several `Agent` beans are each reachable at `/agent/{beanName}`; override the base
path with `ag-ui.server.path`.

This starter is versioned on the **Spring Boot 3.4.x** line. See the
[root README](../README.md) for the project overview.
