# Configuration

Java configuration is programmatic. The middleware itself does not read a general set of environment variables or an application configuration file.

## `AdkAgUiOptions`

| Option | Default | Meaning |
|---|---:|---|
| `useThreadIdAsSessionId` | `false` | If `true`, uses the AG-UI thread ID directly as the ADK session ID. Only use with a compatible session service and after authorizing thread ownership. |
| `runTimeout` | 10 minutes | Positive timeout applied to each accepted run. |
| `globalConcurrencyLimit` | `10` | Positive process-local limit for accepted runs. This is not a cluster-wide limit. |
| `maxSessionsPerUser` | `null` | Positive process-local tracked-session cap per user; `null` is unlimited. |
| `emitMessagesSnapshot` | `false` | Emit one refreshed `MESSAGES_SNAPSHOT` at the end of an accepted run. |
| `deleteSessionOnCleanup` | `true` | Delete expired/evicted sessions from the backing session service. |
| `saveSessionToMemoryOnCleanup` | `true` | Add expired/evicted sessions to the memory service before deletion. |

Use `AdkAgUiOptions.defaults()` or construct the record directly. Copy helpers are available for messages snapshots, cleanup behaviors, and the per-user cap.

```java
var options = new AdkAgUiOptions(
        false,
        Duration.ofMinutes(5),
        8,
        25,
        true,
        true,
        true);
```

The timeout and caps do not bound HTTP request bodies, message counts, state size, tool-schema size, model output, A2UI output, or SSE event size. Apply those limits in the host and gateway.

## Identity resolution

A user ID is mandatory:

```java
.userId("single-user")
// or
.userIdExtractor(input -> authenticatedPrincipalId(input))
```

Do not configure both. Static identity is appropriate only for trusted single-user/local applications. In multi-user services, the extractor must return a verified server-side principal. Values in `RunAgentInput.state`, `context`, `forwardedProps`, or client-supplied headers are not authenticated by the middleware.

Application name resolution is optional:

```java
.appName("my-app")
// or
.appNameExtractor(input -> resolveAllowedApp(input))
```

If neither is provided, the backing runner's app name is used. Do not configure both.

Identity is part of session and HITL scope. Keep it stable across continuation requests, and include tenant identity where IDs could otherwise collide.

## ADK services and session mapping

`GoogleAdkAgent.fromApp(...)` requires explicit `BaseSessionService`, `BaseMemoryService`, and `BaseArtifactService` instances. In-memory implementations are useful for development but lose data on restart and do not coordinate replicas.

`SessionManager` also owns a `ThreadSessionMappingStore`. The default `InMemoryThreadSessionMappingStore` is process-local. With generated ADK session IDs (`useThreadIdAsSessionId=false`), production multi-instance deployments need a shared mapping implementation or sticky routing plus an accepted loss-of-resume policy. A persistent ADK session service alone does not make the mapping store shared.

For direct thread IDs (`true`), authorize `(app, user, thread)` before running. User-supplied thread IDs remain untrusted object identifiers.

## Session cleanup

Automatic cleanup is opt-in on the builder:

```java
.sessionCleanupPolicy(new SessionCleanupPolicy(
        Duration.ofMinutes(20),  // inactivity expiry
        Duration.ofMinutes(5),   // cleanup interval
        Duration.ofHours(24)))   // maximum HITL preservation; null means indefinite
```

The two-argument constructor preserves sessions with pending HITL calls indefinitely. Cleanup policy becomes fixed once cleanup scheduling starts. The independent `AdkAgUiOptions` flags decide whether cleanup archives to memory and/or deletes from the backend.

Use a shared/durable memory service if archived conversations must survive restart. Test cleanup policies against the chosen ADK service because service timestamps and persistence behavior are service-owned.

## Run config

The builder accepts a base ADK `RunConfig`:

```java
.baseRunConfig(RunConfig.builder().build())
```

The bridge derives request-specific metadata/state from that base without using mutable global request state. Configure model streaming and other ADK-supported run options on `RunConfig`; consult the Google ADK Java version used by this module (`1.7.0`) rather than copying Python-only options.

## Backend tool names

The builder requires an authoritative set:

```java
.configuredBackendToolNames(Set.of("lookup_order", "cancel_order"))
```

Use `Set.of()` if there are none. Dynamic sources must publish every possible visible name. The bridge does not invoke arbitrary dynamic discovery while preparing a request. See [TOOLS.md](TOOLS.md).

## Optional message snapshots

Enable with `options.withEmitMessagesSnapshot(true)`. The default history provider reads the refreshed ADK session after a run. A custom `MessageHistoryProvider` can be installed when the backing service needs a different completeness strategy.

Snapshots increase read traffic and response size. Treat message history as sensitive application data.

## Concurrency

- `globalConcurrencyLimit` is enforced by an `InProcessGlobalExecutionLimiter`.
- The default `InProcessExecutionCoordinator` coordinates same-thread execution only within one process.
- `maxSessionsPerUser` is tracked in process.

For multiple instances, enforce admission control and same-thread serialization in shared infrastructure, or use sticky routing with clearly documented failure behavior. Do not assume these settings provide distributed locking.

## HITL and interrupt stores

The builder defaults to:

- `SessionPendingCallStore`
- `SessionInterruptStore`
- `SessionConfirmationRequestStore`
- `SessionMessageReservationStore`

The pending-call and interrupt implementations are process-local. The builder exposes replacement seams (`pendingCallStore`, `interruptStore`, `confirmationRequestStore`, and `messageReservationStore`). A production distributed implementation must preserve the interfaces' atomic claim, duplicate-detection, grouping, and finalization semantics; a simple cache is insufficient.

## Capabilities

Applications may declare a JSON-serializable capability map:

```java
.capabilities(Map.of("vendor.example.feature", true))
```

`agent.capabilities()` returns a detached copy, or `null` if capabilities were never declared. This module does not publish a GET endpoint; the host decides whether and where to expose the value and must apply authentication as appropriate.

## Auth actions

Google ADK Java 1.7 does not provide the Python middleware's complete auth-input surface. Auth compatibility actions are accepted only through an explicitly installed `AdkAuthRequestAdapter`:

```java
.authRequestAdapter(request -> handleAuthInApplication(request))
```

The adapter returns official AG-UI events and receives immutable request-local data. It is not an authentication middleware. The host must authenticate and authorize the HTTP caller before invoking the agent, and adapter implementations must avoid leaking secrets in events or logs.

## A2UI

Backend auto-injection uses `Builder.a2uiConfig(Map<String,Object>)`. Supported configuration keys are consumed by the A2UI implementation and include `inject_a2ui_tool`, `catalog`, `default_catalog_id`, `guidelines`, and recovery controls. The request `forwardedProps.injectA2UITool` flag takes precedence over the backend injection flag.

Because this surface is map-based, use only values demonstrated by current tests/code and validate configuration during startup. A2UI v0.9 schema resources are bundled. A2UI content can be large; enforce request/output budgets outside the bridge.

## Logging

The module uses SLF4J API and defines no log-level environment variables. Configure the provider and logger levels in the hosting application. See [LOGGING.md](LOGGING.md).

## Live Vertex smoke test

Live tests are excluded from normal `mvn test`. The live profile has two modes.

Run its network-free sentinel:

```bash
mvn -Plive-tests -DliveSmokeEnabled=false test
```

Run the credentialed Vertex smoke explicitly:

```bash
mvn -Plive-tests \
  -DliveSmokeEnabled=true \
  -DAGUI_ADK_VERTEX_PROJECT=my-project \
  -DAGUI_ADK_VERTEX_LOCATION=us-central1 \
  -DAGUI_ADK_VERTEX_MODEL=gemini-2.5-flash \
  test
```

The credentialed test additionally requires environment variable `AGUI_ADK_LIVE_SMOKE=true` and Application Default Credentials usable by the Google GenAI Vertex client. `AGUI_ADK_VERTEX_MODELS` may be supplied as a comma-separated system property of `model@location` entries to test several combinations.

These `AGUI_ADK_VERTEX_*` values are test inputs read as Java system properties, not runtime middleware configuration.
