# CLI Agent Orchestrator (CAO) × AG-UI — Architecture

This integration renders a **live multi-agent fleet of real CLI coding agents**
through AG-UI. It is a thin projection of a surface CAO already ships upstream
(awslabs/cli-agent-orchestrator#458, merged) — not a re-implementation.

## Why CAO is a different kind of AG-UI source

Every other integration in this repo binds **one framework** to the protocol and
assumes an addressable HTTP agent already exists. CAO sits on the empty axis
between multi-CLI orchestrators (real processes, no protocol) and AG-UI
frameworks (protocol, no real processes). It brings, net-new to the ecosystem:

1. **A real-process agent runtime.** CAO spawns, persists, resumes, and
   multiplexes long-lived CLI agent processes (tmux-backed), then exposes that
   lifecycle through AG-UI. No other AG-UI source manages real OS processes.
2. **One stream over N heterogeneous runtimes.** Kiro CLI, Claude Code, and
   Codex all speak the same normalized stream; a new provider joins by
   implementing one base interface — zero protocol code.
3. **Permission prompts as standard interrupts.** CLI agents pause on
   trust/permission prompts constantly. CAO maps that onto AG-UI's interrupt
   lifecycle with provider-namespaced reasons (`claude-code:permission_request`,
   `kiro:trust_prompt`) and approve / deny / edit `resume[]` — this integration's
   demo exercises approve and deny; edit ships upstream. This is the
   flagship demo — something no API-wrapper integration can show.
4. **Fleet semantics as a construct programming model.** Supervisor→worker
   hierarchy, delegation timelines, and cross-provider shared state, exposed as
   typed, subclassable L2 constructs (CDK-style L1/L2/L3) rather than a one-off
   adapter.
5. **A privacy-bounded observability posture.** Metadata-only streaming —
   message bodies never on the wire, asserted by tests.

**Roadmap fit.** CAO is a live testbed for the AG-UI roadmap against *real
processes*: sub-agents / composition, interrupt-aware runs (HITL), steering,
tool-output streaming, and shared state are all exercised here, and declarative
generative UI + background agents map onto the `emit_ui` allow-list and the
persistent tmux fleet. It also completes the protocol triad — MCP (shipped),
agent-to-agent handoffs (shipped), and AG-UI — over real CLI processes (the A2A
transport itself is out of scope for this PR).

## Layers

```
L3  Composed surfaces (dashboards, team control planes)   [downstream]
L2  Named, subclassable constructs                        [awslabs/cli-agent-orchestrator#458]
      SupervisorDashboardStream · MultiAgentSessionTimeline
      AgentHandoffWithApproval · CrossProviderStateSync
L1  Raw protocol adapter (one pure module, default-off)   [#436]
      services/agui_stream.py  → CAO primitives → AG-UI typed events
      GET  /agui/v1/stream      (ambient SSE, CAO dialect)
      POST /agui/v1/run         (stock EventEncoder frames + interrupt/resume)
L0  Existing CAO substrate (unchanged)
      event bus · event_primitives · ui_state_service · tmux terminals · providers
```

## What this directory ships

```
typescript/   @ag-ui/cli-agent-orchestrator — `CliAgentOrchestratorAgent extends HttpAgent`
              (zero extra wire code; consumes CAO's stock run plane directly)
python/       keyless example server driving CAO's `mock_cli` fleet through
              run_plane_stream, exposing five Dojo features on port 8027:
                agentic_chat · shared_state · human_in_the_loop ·
                agentic_generative_ui · interrupt (flagship)
```

## Wire contract (consumed, not re-implemented)

The example server calls CAO's merged `run_plane_stream`
(`cli_agent_orchestrator.services.agui.run_plane`) with keyless, deterministic
fixtures. That function is the single authority for frame shape and the
interrupt lifecycle:

- `RUN_STARTED` → `STATE_SNAPSHOT` → projection frames → `RUN_FINISHED`
- Open interrupt → `RUN_FINISHED outcome={type:"interrupt", interrupts:[…]}`
- Client answers via `resume:[{ interruptId, payload }]` (idempotent,
  exactly-once resolution).

Because the server reuses CAO's own encoder + interrupt registry, there is no
cross-repo drift: it depends only on the published `cli-agent-orchestrator[agui]`
extra (`ag-ui-protocol>=0.1.19,<0.2.0`), never on a CAO source checkout.

## Keyless by construction

The `mock_cli` fleet needs no external API keys and no real tmux/browser, so the
example server and the whole e2e/CI path run secret-free. The features emit
**fleet-lifecycle** frames (not LLM chat), which is the point: this integration
showcases orchestration and interrupts, not another chat wrapper.

## Backends: projection (default) and mock (zero-dependency)

The example server ships two keyless backends for the same five features,
selected automatically (override with `CAO_AGUI_MODE=projection|mock`):

- **projection** *(default when the `cao` extra is installed)* — each route is a
  thin call into CAO's merged run plane
  (`cli_agent_orchestrator.services.agui.run_plane.run_plane_stream`). Highest
  fidelity: it exercises CAO's real AG-UI Phase 2 code, interrupt registry, and
  frame shapes. Enable with `uv sync --extra cao`, which resolves
  `cli-agent-orchestrator[agui]>=2.4.1,<3` from PyPI — Phase 2 shipped in `2.4.1`
  (2026-08-04), so no VCS pin is needed.
- **mock** *(zero-dependency fallback)* — self-contained emitters in `_mock.py`
  built only on `ag_ui.core`/`ag_ui.encoder`, with **no `cli-agent-orchestrator`
  dependency**. A bare `uv sync` (and the keyless CI e2e) runs this path
  anywhere, with no external processes or keys.

Both satisfy the same fail-closed contract suite (`tests/test_server.py`): the
shared lifecycle, the interrupt approve/deny round-trip, and the privacy
boundary are asserted in **both** modes; backend-specific frames (projection:
`STEP_*`/`STATE_DELTA`/`CUSTOM cao.generative_ui`; mock: `TEXT_MESSAGE_*`/
`TOOL_CALL_*`) are asserted per mode.

## Generative UI (upstream)

Beyond the run-lifecycle frames, agents author UI as a **frozen, server-validated
allow-list** of six components (`agent_card`, `approval_card`, `choice_prompt`,
`diff_summary`, `metric`, `progress`) via the `emit_ui` tool — no HTML, no
script, props JSON-only and bounded to 8 KB. Off-list components are **refused
server-side** and never rendered. On AG-UI's control↔flexibility spectrum this is
the **declarative** flavor of generative UI (schema-selected components, not
open-ended raw HTML) — which is what lets an untrusted CLI agent drive UI safely
and render uniformly across providers. See the `ag-ui-eventsource-viewer` demo
below and [`docs/agui.md`](https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/agui.md#generative-ui).

## Demos & evidence (dogfooded, PASS-gated)

CAO's own PASS-gated recorder generates these demos in CI — the fleet
visualizing itself through this exact AG-UI surface ("the audit fleet visualizes
itself") — and commits them to the canonical repo under `docs/media/`
(media pinned to `f45f3222`; the code dependency is the PyPI constraint above, not
this SHA):

- Handoff approval → interrupt → `resume[]`: [`ag-ui-handoff-approval-demo.gif`](https://raw.githubusercontent.com/awslabs/cli-agent-orchestrator/f45f322217647e447febe5dd5c7adc551182c822/docs/media/ag-ui-handoff-approval-demo.gif)
- Cross-provider state sync (≥3 providers, uniform render): [`ag-ui-cross-provider-sync-demo.gif`](https://raw.githubusercontent.com/awslabs/cli-agent-orchestrator/f45f322217647e447febe5dd5c7adc551182c822/docs/media/ag-ui-cross-provider-sync-demo.gif)
- Supervisor dashboard: [`ag-ui-supervisor-dashboard-demo.gif`](https://raw.githubusercontent.com/awslabs/cli-agent-orchestrator/f45f322217647e447febe5dd5c7adc551182c822/docs/media/ag-ui-supervisor-dashboard-demo.gif)
- Multi-agent session timeline: [`ag-ui-session-timeline-demo.gif`](https://raw.githubusercontent.com/awslabs/cli-agent-orchestrator/f45f322217647e447febe5dd5c7adc551182c822/docs/media/ag-ui-session-timeline-demo.gif)
- EventSource viewer (raw AG-UI stream): [`ag-ui-eventsource-viewer-demo.gif`](https://raw.githubusercontent.com/awslabs/cli-agent-orchestrator/f45f322217647e447febe5dd5c7adc551182c822/docs/media/ag-ui-eventsource-viewer-demo.gif)
- Stock CopilotKit client (zero custom adapter): [`ag-ui-copilotkit-demo.gif`](https://raw.githubusercontent.com/awslabs/cli-agent-orchestrator/f45f322217647e447febe5dd5c7adc551182c822/docs/media/ag-ui-copilotkit-demo.gif)

Provenance (canonical awslabs CI): run [`30130556114`](https://github.com/awslabs/cli-agent-orchestrator/actions/runs/30130556114) — jobs [`89603863228`](https://github.com/awslabs/cli-agent-orchestrator/actions/runs/30130556114/job/89603863228), [`89603863267`](https://github.com/awslabs/cli-agent-orchestrator/actions/runs/30130556114/job/89603863267), [`89603863218`](https://github.com/awslabs/cli-agent-orchestrator/actions/runs/30130556114/job/89603863218).

## References

- CAO AG-UI surface & docs: https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/agui.md
- Phase 2 (L2 constructs + run plane): awslabs/cli-agent-orchestrator#458
- Phase 0–1 (L1 adapter): awslabs/cli-agent-orchestrator#436

## Upstream roadmap & scope boundary

The projection backend resolves `cli-agent-orchestrator[agui]>=2.4.1,<3` from PyPI. `2.4.1`
contains the cross-site-WebSocket-hijacking guard on the terminal socket (CWE-1385,
awslabs/cli-agent-orchestrator#533 — the commit this integration previously pinned directly) and
read-only profile search/template/preview endpoints (awslabs/cli-agent-orchestrator#523).

Further AG-UI operator surfaces — an L3 fleet-operations dashboard and candidate new L2
constructs (profile/agent catalog, interactive agent builder, run/team composition, cross-node
fleet federation) — are tracked **upstream** in awslabs/cli-agent-orchestrator#519, which names
this Dojo PR as its downstream consumer. Per that issue's non-goals, this integration
deliberately stays the thin **L1/L2 consumer + the standard Dojo features** (agentic_chat,
shared_state, human_in_the_loop, agentic_generative_ui, interrupt): no new protocol code and no
additions to the frozen
six-component `emit_ui` allow-list live here. A genuinely new need becomes a new typed L2
construct upstream, then this consumer projects it — keeping metadata-only-on-the-wire and the
default-off `CAO_AGUI_ENABLED` contract intact.
