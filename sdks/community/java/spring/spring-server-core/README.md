# ag-ui-spring · spring-server-core


Framework-agnostic code shared by the AG-UI Spring server modules
([`spring-webflux-server`](../spring-webflux-server) and
[`spring-webmvc-server`](../spring-webmvc-server)). It has **no Spring
dependency** — only Jackson and the `ag-ui` `server` module.

## What's inside

| Type | Purpose |
|------|---------|
| [`JacksonSerializer`](src/main/java/com/agui/community/spring/server/core/JacksonSerializer.java) | A `Serializer` backed by Jackson, configured to handle the sealed `Event` (by `type`) and `Message` (by `role`) hierarchies polymorphically, with `Role`/`EventType` bound to their wire values. |
| [`AgentNotFoundException`](src/main/java/com/agui/community/spring/server/core/AgentNotFoundException.java) | Thrown when a request addresses an unknown agent id; each server's controller maps it to `404`. |
| [`jackson`](src/main/java/com/agui/community/spring/server/core/jackson) mix-ins | The `Event`/`Message` Jackson mix-ins that keep the `ag-ui` `core` module free of Jackson annotations. |

Each server module adds its own transport-specific controller and auto-configuration
on top of this. You normally depend on one of the server modules (or its starter)
rather than on `spring-server-core` directly.

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>ag-ui-spring-server-core</artifactId>
    <version>4.1.0</version>
</dependency>
```

> Versioned on the **Spring Boot 3.4.x** line (it shares that line's Jackson
> version). See the [root README](../README.md) for the project overview.
