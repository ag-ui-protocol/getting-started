# Architecture

## Scope

The module is a framework-neutral bridge between the community Java AG-UI model and Google ADK Java. It does not own HTTP authentication or a production deployment platform.

```text
AG-UI RunAgentInput
        |
        v
 GoogleAdkAgent -- identity/input validation
        |
        +--> SessionManager -- thread/session resolution and state
        +--> tool/HITL stores -- request correlation and claims
        |
        v
 AdkRunnerClient --> Google ADK Runner --> ADK Event stream
        |
        v
 EventTranslator --> AG-UI Flow.Publisher<Event>
        |
        v
 hosting adapter --> SSE (or another application transport)
```

## Main components

### `GoogleAdkAgent`

The orchestration boundary. It implements the official community Java `Agent`, validates input and identity, resolves a session, coordinates execution, processes messages/tool results/resumes, invokes ADK, translates events, and finalizes session/message bookkeeping. It is `AutoCloseable`.

`run(...)` returns a cold publisher: orchestration begins on subscription. Request cancellation is propagated through a cancellation token and request-resource registry.

### `AdkRunnerClient`

A narrow seam around ADK runner calls. `GoogleAdkRunnerClient` delegates to the official `Runner`. For A2UI it can rebuild a runner around a per-run agent tree while carrying the original services and plugins.

### `SessionManager`

Maps `(appName, userId, threadId)` to an ADK session, initializes/synchronizes state, tracks processed messages, maintains per-execution read caches, enforces the process-local per-user cap, and schedules optional cleanup. It coordinates same-JVM read/modify/write operations, but does not provide distributed transactions.

### Input and request context

`RunInputValidator` validates required IDs, messages, resumes, and extension/schema pairing. `AdkAgUiRunContext` carries immutable request-scoped input, context, forwarded properties, raw schemas, cancellation, and owned resources into ADK run metadata. `metadataEnricher` is the application extension point.

### Translation

`EventTranslator` and its steps translate text, reasoning, tool calls/results, state changes, ADK metadata, and errors. Translator state is created per run. Agents with `output_schema` can be discovered so structured output is not also leaked as chat text.

### Tool bridge

`AgUiToolset` reads frontend tool declarations from request metadata, normalizes schemas, and produces request-specific long-running `ClientProxyTool` declarations. `FrontendToolExposure` records the effective names after filtering/prefixing for the translator.

### HITL and interrupts

Pending frontend calls, confirmation requests, official interrupts, results, and resume claims are modeled behind store interfaces. Group admission ensures a run resumes only when its required sibling responses are ready and gives one claimant finalization authority within the store's consistency scope.

Default implementations use concurrent JVM collections. Their atomicity is process-local.

### A2UI

A2UI wiring is request-scoped. The bridge can inject/bind an A2UI sub-agent tool, validate/heal model JSON, normalize catalogs, and drain generated operations into the AG-UI event stream. Bundled resources target A2UI v0.9.

### Serialization and transport

`JacksonAgUiSerializer` configures official AG-UI polymorphic wire types. `PreEncodedSseEventEncoder` preserves already validated pending frontend-call JSON; ordinary events delegate to the community Java `SseEventEncoder`.

HTTP remains a hosting concern. The community `java-server` module provides `AgentRunHandler` and `JdkAgentHttpHandler`; applications may integrate another servlet/reactive stack using `AgentRunHandler` and `EventSink`.

## Run lifecycle

A normal run follows this outline:

1. Validate `RunAgentInput` and any compatibility extension.
2. Resolve app/user identity.
3. Emit `RUN_STARTED` and acquire process-local admission/coordination.
4. Resolve or create the ADK session and merge initial request state.
5. Reserve unseen messages so duplicate subscriptions/retries do not blindly replay them.
6. Process frontend results or official resumes; otherwise select the latest user content.
7. Build request metadata, frontend tools, and optional A2UI wiring.
8. Run ADK and translate its event stream.
9. Commit processed-message and pending-call state.
10. Optionally refresh history and emit `MESSAGES_SNAPSHOT`.
11. Emit the terminal lifecycle event, release resources, and schedule cleanup.

Failures are generally represented as `RUN_ERROR`; stream subscribers must still handle publisher `onError`. The exact terminal sequence depends on failure path and protocol contract, so consumers should treat the first terminal run event as authoritative and close the response when the publisher terminates.

## Session identity and state

Generated session IDs are the default. The mapping key includes app, user, and AG-UI thread. Protected state markers allow session recovery scans, but the default fast mapping is in memory. Direct thread IDs can be enabled for compatible services.

Request state is application/model-visible data. The bridge also persists internal bookkeeping in session state. Applications should avoid private bridge keys and must not store credentials in conversation state.

## Concurrency model

- Global accepted-run limiting: one JVM.
- Same-thread execution coordination: one JVM by default.
- Per-session mutation monitors/caches: one JVM.
- Per-user session tracking: one JVM.
- Default pending-call/interrupt claims: one JVM.
- Reactive ADK and AG-UI streams: RxJava internally, adapted to JDK `Flow` publicly.

A load-balanced deployment needs distributed equivalents or sticky routing. Merely sharing the ADK session database does not distribute every bridge coordination structure.

## Known risks and deployment limits

### Sensitive headers and identity spoofing

`HeaderExtraction` only normalizes a header name; it does not authenticate its value. Copying `Authorization`, cookies, session tokens, API keys, tracing baggage, or arbitrary headers into state can expose them to the model, tools, events, logs, and durable session storage. Extract only a small allowlist after authentication. Derive identity from the verified server principal and authorize thread ownership.

### Unbounded payload and schema sizes

The middleware validates shapes and some identifiers, but has no comprehensive bound for request bytes, number/length of messages, state depth/size, tool count, JSON Schema bytes/depth/properties, tool result bytes, model event bytes, A2UI tree/data size, or accumulated session history. Large inputs can exhaust heap, CPU, model context, backing-service quotas, or network buffers. Enforce budgets at the reverse proxy and application boundary before deserialization/run admission, and cap generated/output content where the chosen ADK/model supports it.

### Process-local HITL stores

Default pending-call and interrupt stores use process memory. Restart loses correlations/tombstones; another process cannot observe them; exactly-once claims extend only to callers sharing the same store object. Replace the store interfaces with durable distributed atomic implementations for restart-safe/multi-instance HITL, or require sticky routing and accept process-loss failure.

### Multi-instance consistency

The default thread-session mapping, concurrency limiter, execution coordinator, per-user tracking, mutation locks, and caches are local. Two replicas can accept the same thread concurrently or resolve different generated sessions. Use a shared mapping and distributed locking/admission strategy, or a routing key that pins `(app,user,thread)` to one live instance.

### Authentication and authorization

The bridge is not auth middleware. The optional `AdkAuthRequestAdapter` handles an AG-UI/ADK compatibility action after request admission; it does not establish caller identity. Hosts must authenticate every initial and continuation request, authorize app/thread/tool/interrupt access, and protect capabilities/replay endpoints. Re-authorize privileged actions after HITL approval.

### In-memory ADK services

ADK in-memory session, memory, and artifact services are development conveniences. They lose conversations and artifacts on restart and are not shared. Select persistent service implementations appropriate for production and verify their consistency/latency characteristics.

### Logging and data exposure

Current log messages include app, user, session, thread, tool names, and failures in some paths. Exception objects from downstream libraries may contain provider/request details. Configure retention and access accordingly; do not enable verbose logs with real sensitive payloads without redaction at the application/provider layer.

### A2UI and structured output trust

Schema validation does not make model output safe or authorized. The client must safely render content; the server must allowlist and authorize any action triggered from generated UI. Limit tree/data size and reject unknown catalogs/components/actions.

## Extension boundaries

The durable/multi-instance seams are explicit interfaces rather than built-in databases:

- `ThreadSessionMappingStore`
- `PendingCallStore`
- `InterruptStore`
- `ConfirmationRequestStore`
- `MessageReservationStore`
- `ExecutionCoordinator`
- `MessageHistoryProvider`
- `AdkAuthRequestAdapter`
- `CanonicalEventEncoder`

Implementations must honor atomicity, idempotency, scoping, and ordering documented by the interface methods and verified by tests. Test crash/retry and concurrent submissions, not only happy-path CRUD.
