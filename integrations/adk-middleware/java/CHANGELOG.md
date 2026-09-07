# Changelog

All notable changes to the standalone Java ADK middleware are documented here. The module does not yet have a documented published release history.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version dates and release links will be added when artifacts are released.

## [Unreleased]

### Added

- Standalone Java 21 Maven module bridging Google ADK Java to the community Java AG-UI `Agent` interface.
- ADK-to-AG-UI translation for lifecycle, streaming text, reasoning, tools, tool results, state, metadata, errors, and optional message snapshots.
- Session resolution, state synchronization, processed-message reservations, cleanup policies, memory archival, and generated thread-to-session mappings.
- Frontend `AgUiToolset` with filtering, prefixing, raw JSON Schema normalization, and long-running `ClientProxyTool` declarations.
- Frontend tool-result continuation, grouped pending calls, official AG-UI interrupts/resumes, ADK confirmation translation, and pending-call replay.
- `GoogleAdkAgent.fromApp(...)` and advanced builder construction.
- Request-scoped metadata enrichment and compatibility extensions for raw tool schemas, parent runs, and optional application-owned auth actions.
- A2UI v0.9 catalog, validation, healing, recovery, history, per-run wiring, and operation streaming.
- Canonical Jackson serialization and exact pre-encoded pending-call SSE support.
- Process-local concurrency limiting, same-thread coordination, cancellation propagation, and close/shutdown lifecycle.
- Default Java and Node protocol tests plus an opt-in Vertex live smoke test.
- Expanded README, architecture, configuration, usage, tools/HITL, logging, and deployment-risk documentation.

### Security

- Documented that HTTP authentication/authorization, sensitive-header handling, payload/schema/output limits, rate limiting, TLS, and CORS are hosting responsibilities.
- Documented that default HITL/interrupt coordination, thread-session mappings, and several concurrency controls are process-local and require shared atomic implementations or sticky routing in multi-instance deployments.

## Versioning note

The current Maven coordinate is `com.ag-ui.community:adk-middleware:0.1.0`. Until a release is available from a configured repository, install it locally and pin the exact source revision used to build the artifact.
