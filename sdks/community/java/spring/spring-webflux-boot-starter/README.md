# ag-ui-spring · spring-webflux-boot-starter


Spring Boot starter that exposes an AG-UI
`Agent`
over a reactive (**WebFlux**) HTTP Server-Sent Events endpoint.

Add this single dependency and define one `Agent` bean — auto-configuration
(from [`ag-ui-spring-webflux-server`](../spring-webflux-server)) wires a `Serializer` and the
`/agent` endpoint around it. For a Servlet (WebMVC) app, use
[`ag-ui-spring-webmvc-boot-starter`](../spring-webmvc-boot-starter) instead.

## Usage

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>ag-ui-spring-webflux-boot-starter</artifactId>
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
Override the path with `ag-ui.server.path`.

> Use this when you bring your own `Agent`. To expose a **Spring AI** model with
> no code, use [`ag-ui-spring-ai-spring-boot-starter`](../spring-ai-spring-boot-starter)
> instead.

This starter is versioned on the **Spring Boot 3.4.x** line. See the
[root README](../README.md) for the project overview.
