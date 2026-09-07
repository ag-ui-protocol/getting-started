# Tools, HITL, auth, and A2UI

## Frontend tools

Add `AgUiToolset` to an ADK `LlmAgent` to expose tools supplied in the current AG-UI request:

```java
var agent = LlmAgent.builder()
        .name("assistant")
        .model("gemini-2.5-flash")
        .tools(new AgUiToolset())
        .build();
```

The toolset is stateless. On each invocation it reads request-scoped metadata, converts the corresponding JSON schemas to Google GenAI `Schema` values, and creates new `ClientProxyTool` instances. A proxy is marked long-running, returns an empty acknowledgement to ADK, and never executes browser/application code in the JVM.

The bridge translates the model call into AG-UI tool-call events. The frontend performs the work and submits its result in a later request.

### Filtering and prefixing

```java
new AgUiToolset(List.of("show_sports_list"), "frontend")
```

Filtering uses original frontend names. Prefixing happens afterward, producing `frontend_show_sports_list`. A `ToolPredicate` constructor is also available for context-aware selection.

When several `AgUiToolset` instances appear in an agent tree, the request-scoped exposure registry collects all effective names for event translation.

### Schema conversion

Official Java AG-UI tool parameter types do not retain every raw JSON Schema term needed for Gemini conversion. `AdkRunExtensions.rawToolSchemas` can attach positional raw schemas to a copied request. Entries must match the official tool list by position and name.

The converter normalizes common rich-schema constructs and retains supported Gemini fields including object properties, items, `anyOf`, enums, required fields, descriptions, formats, patterns, defaults/examples, and several numeric/length constraints. Unsupported or malformed schemas are skipped per frontend tool with a warning; invalid raw-schema pairing rejects the request.

**No general size budget is enforced.** Deep, wide, or very large schemas consume CPU, memory, model context, and event bandwidth. Limit tool count, schema bytes, depth, property count, and descriptions before invoking the bridge.

### Name collisions

The builder requires `configuredBackendToolNames(...)`. Frontend/backend names must not collide after filtering/prefixing. Publish all possible dynamic backend names; the bridge deliberately does not probe opaque dynamic tool sources.

Tool names are validated. Prefer stable identifier-like names and use prefixes to make ownership clear.

## Backend tools

Ordinary ADK tools registered on the agent execute in the backend according to ADK behavior. Their calls/results are translated into AG-UI events where supported. They are distinct from `ClientProxyTool`, which only declares frontend-owned work.

Do not put privileged backend operations behind a frontend tool merely because the UI displays an approval. Server-side authorization must be checked again when performing the privileged action.

## Frontend result and HITL flow

A typical long-running flow is:

1. Client sends a user message plus tool declarations.
2. ADK selects a frontend tool.
3. The bridge persists/correlates the call and emits tool-call events or an AG-UI interrupt.
4. The client performs work or collects a decision.
5. A continuation request returns a `ToolMessage` and/or official `Resume` entries.
6. The bridge validates scope, duplicate/conflicting submissions, sibling-call completeness, and resumes the ADK run when the group is ready.

Multiple sibling long-running calls are grouped: early results may be buffered until all required results for that invocation group arrive. Continuations must keep the same authenticated app/user/thread scope.

The middleware supports both the historical tool-message path and official AG-UI interrupts. Prefer the official `RunAgentInput.resume` contract when the client supports it. A cancelled resume must have a null payload; malformed or duplicate interrupt IDs are rejected.

### ADK-native resumability

`GoogleAdkAgent.fromApp(...)` detects whether the supplied `App` has resumability enabled and selects the corresponding run path. Configure resumability on the ADK `App` using APIs available in the pinned Java ADK version. Do not assume Python ADK constructor names or behavior are identical.

### Replay

`GoogleAdkAgent.replayPendingCalls(...)` replays unresolved frontend calls for a resolved app/user/thread scope. It is an application-facing primitive, not an HTTP endpoint. Authenticate and authorize the caller before exposing it.

### Durability warning

Default pending-call, interrupt, confirmation, reservation, and thread-mapping behavior includes process-local state. A restart can lose pending correlations; another replica may not see or atomically claim them. For multi-instance or restart-safe HITL, install shared implementations with atomic group claims and idempotent finalization, or route every continuation to the original process and accept failure on process loss.

## ADK confirmation requests

The bridge translates native ADK confirmation requests and correlates replies through `ConfirmationRequestStore`. The default `SessionConfirmationRequestStore` should not be treated as a distributed persistence solution. Keep confirmations principal-scoped and re-authorize the operation after approval.

Approval is not authorization: capture immutable operation details, prevent substitution between display and execution, and record an application audit trail outside this bridge.

## Auth compatibility actions

`AdkRunExtensions.AuthAction` represents an auth input the official AG-UI Java model cannot express directly. It is handled only when `Builder.authRequestAdapter(...)` is installed. Without an adapter, the bridge cannot claim Python auth parity.

An adapter:

- receives immutable request ID, input, and run context;
- returns a stream of official AG-UI events;
- is request-local and must not use bridge-wide mutable request state.

It does **not** authenticate the HTTP request, store credentials, implement OAuth callbacks, or provide an endpoint. Those are application responsibilities. Never emit access tokens, refresh tokens, authorization codes, cookies, or API keys in AG-UI events.

## A2UI

The Java bridge contains A2UI v0.9 schema validation, catalog normalization/rendering, JSON healing, recovery, history, and per-run tool wiring. A root agent may be rebuilt per run so `A2UISubAgentTool` instances are bound to that request's event queue.

Auto-injection is planned from:

- request `forwardedProps.injectA2UITool`, when present; otherwise
- backend `a2uiConfig.inject_a2ui_tool`.

The config may also provide a catalog, default catalog ID, guidelines, and recovery settings. A2UI operations include `createSurface`, `updateComponents`, and `updateDataModel`.

A2UI does not make generated UI trusted. Validate catalog IDs and application actions, constrain component/data sizes, escape/render content safely in the client, and never treat model-generated component arguments as authorization to call a backend.

## Tool safety checklist

- Authenticate users and authorize app/thread ownership before the run.
- Keep backend authorization at the operation boundary, including after approval.
- Allowlist frontend tools and prefix names in mixed toolsets.
- Limit schema bytes/depth/properties and tool/result payload sizes in the host.
- Avoid secrets and sensitive personal data in tool descriptions, arguments, results, state, and logs.
- Use distributed atomic stores or sticky routing for multi-instance HITL.
- Make tool results idempotent and reject conflicting duplicates.
- Treat A2UI and all model-produced structured data as untrusted input.
