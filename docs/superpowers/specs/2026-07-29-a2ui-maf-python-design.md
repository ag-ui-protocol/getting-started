# A2UI for Microsoft Agent Framework (Python) — Assessment + Completion Plan

Date: 2026-07-29
ag-ui worktree: `claude/modest-yalow-05a21f` (`sad-buck-d2573f`) — dojo/e2e side.
MAF worktree: `/Users/ran/Desktop/agent-framework-a2ui-py` (fork `ranst91/agent-framework`,
branch `feat/a2ui-toolkit-python`) — adapter + demos + unit tests.

## Home decision (settled)

A2UI lives **with whoever owns the AG-UI bridge for the framework**. For .NET, ag-ui
owns the bridge (AGUI.Server) → A2UI shipped in the ag-ui repo. For MAF-Python,
**microsoft owns the bridge** (`agent_framework_ag_ui`, `python/packages/ag-ui`) → A2UI
belongs there. It ships as an in-package `_a2ui/` submodule (mirroring how
`ag_ui_langgraph` keeps `a2ui_tool.py` in-package — NO new pip package), reuses the
published, framework-agnostic `ag-ui-a2ui-toolkit`, and follows the
langgraph/strands Python pattern (`plan_a2ui_injection` + a subagent runner). The .NET
decorator model is the outlier (forced by M.E.AI coalescing tool args); Python follows
the other frameworks.

## What already exists on the branch (verified by reading)

The framework-specific layer is **built and API-consistent** with the checkout's
`agent_framework` core (every symbol used — `Agent`, `AgentResponseUpdate`,
`ChatResponse.from_updates`, `Content.from_function_*`, `FunctionTool(func=None,
input_model=<dict>)`, `normalize_messages` — exists and matches usage):

- `agent_framework_ag_ui/_a2ui/_agent.py` — `A2UIAgent`: streaming planner loop
  (≤8 rounds, declaration-only `generate_a2ui`, forwards per-chunk `render_a2ui`
  fragments, balances the render call with `{"status":"rendered"}`, closing turn) and
  a non-streaming path (real `generate_a2ui` tool → toolkit sync recovery loop in an
  executor). Streaming recovery is a validate→retry twin with the exhaustion envelope.
  Mid-stream failure balances the live render call (`live_render_call_id` learned from
  the first fragment). Error classification rethrows cancellation/TypeError/NameError.
- `_a2ui/_context_agent.py` — `AGUIContextAgent`: renders the forwarded catalog +
  guidelines as a system message (toolkit `build_context_prompt`).
- `_a2ui/_factory.py` — `enable_a2ui(inner, subagent, params)` (explicit wiring) and
  `plan_a2ui_injection(...)` (auto-inject decision, USER-PREVAILS, nullish fallback,
  render-tool drop).
- `_a2ui/_state.py` — AG-UI context plumbing (split schema entry, `injectA2UITool`
  read off `forwardedProps`, stamp/read the `ag_ui_context` slice, history mapping).
- Host-loop patches (`_agent_run.py`, `_agent.py`, `_endpoint.py`, `__init__.py`):
  `run_agent_stream` invokes `plan_a2ui_injection` when `injectA2UITool` is set,
  strips the injected render tool, and stamps the context slice; `a2ui_config`
  threads through `add_agent_framework_fastapi_endpoint` → `AgentConfig`. A2UI symbols
  are lazy so the base package imports without the toolkit.
- `pyproject.toml` — optional `a2ui` extra (`ag-ui-a2ui-toolkit>=0.0.4`).
- `agent_framework_ag_ui_examples/agents/a2ui_agents.py` — 2 demo agents
  (dynamic_schema, recovery) + `A2UI_DEMO_CONFIG`.
- `tests/ag_ui/test_a2ui.py` — 521-line unit suite.

### Pillar status (as built — NOT yet verified against a real LLM)

1. Auto-inject — PRESENT (`plan_a2ui_injection` wired into `run_agent_stream`;
   opt-out via `false`; customizable via `a2ui_config`; USER-PREVAILS).
2. Progressive streaming — PRESENT in code (per-chunk fragment forwarding). MAF
   chat-completions surfaces per-chunk `FunctionCallContent.arguments`
   (`_chat_client.py`), and the bridge emits one `ToolCallArgsEvent` per fragment
   (`_run_common._emit_tool_call`), so no provider RawRepresentation extractor is
   needed. **Must confirm one-by-one paint on a real LLM.**
3. Error recovery — PRESENT (streaming validate→retry twin + `a2ui_recovery_exhausted`).
4. Subagent — PRESENT (forced `render_a2ui` via `tool_choice` required).

## Gaps to close (the actual remaining work)

A. **Real-LLM verification (the whole point; not yet done).** aimock masks two
   hard-won bugs. Editable-install the branch + toolkit, run each demo against real
   OpenAI **chat-completions**, and confirm: incremental paint + "building" skeleton;
   recovery recover + exhaust; the in-flight `generate_a2ui` call is not sent unbalanced
   to the subagent (no HTTP 400); mid-stream failure balances the render call. Then
   re-run under aimock for determinism.

B. **Demos: 2 of 4.** Add `a2ui_advanced` (zero-config: no backend catalog/guide;
   catalog + `injectA2UITool` arrive on `forwardedProps`) and `a2ui_fixed_schema`
   (direct-tool: a plain agent with one backend tool returning an `a2ui_operations`
   envelope as a JSON STRING — no subagent/recovery). Register all four on the examples
   dojo server with `a2ui_config`.

C. **Toolkit availability.** Confirm `ag-ui-a2ui-toolkit>=0.0.4` is published with the
   singular-`child`/`child_cycle` validation (ag-ui#1944). If not, editable-install
   `sdks/python/a2ui_toolkit` for local verification and record the publish/version
   floor as a release dependency.

D. **ag-ui repo side (this worktree).** `apps/dojo/src/agents.ts` (MAF integration id),
   `menu.ts`, regenerate `files.json` — add `a2ui_dynamic_schema`, `a2ui_advanced`,
   `a2ui_recovery`, `a2ui_fixed_schema`; e2e specs mirroring
   `agUiDotnetTests/a2ui*.spec.ts` PLUS a streaming-regression net (≥3 incremental
   `TOOL_CALL_ARGS` frames for the render call + `building` lifecycle on the completed
   SSE body); bump the example's `agent-framework-ag-ui` dep once the branch is
   released (or editable for local).

E. **Unit tests.** Run `test_a2ui.py` green under MAF's `poe`. Add coverage for the two
   new demos' shapes and, if missing, explicit tests for USER-PREVAILS passthrough and
   the mid-stream-balance path.

F. **MAF contribution standard.** Issue-first is satisfied (no NEW package — in-package
   submodule). Ensure `poe check` clean (ruff 120, Google docstrings,
   `from __future__ import annotations`, exception types), CHANGELOG entry, tests dir
   rules. Open the PR from the fork branch.

## Execution order

1. Install + harness: editable-install core + `agent_framework_ag_ui[a2ui]` + toolkit;
   stand up the examples dojo server on real OpenAI chat-completions.
2. Run `test_a2ui.py`; fix any breakage; read the suite to learn assumed run protocol.
3. Real-LLM smoke of the 2 existing demos (dynamic_schema, recovery) via the dojo;
   fix correctness bugs surfaced.
4. Add `a2ui_advanced` + `a2ui_fixed_schema`; verify each on real LLM.
5. ag-ui dojo wiring + e2e (aimock) incl. the streaming-regression net; verify.
6. `poe check`, CHANGELOG, unit-test top-ups; stage the MAF PR + the ag-ui PR.

## Verification bar (do not claim pillars delivered until met)

All four demos green on a REAL model AND under aimock; the e2e streaming net proves
progressive paint; recovery proves recover + exhaust; USER-PREVAILS + opt-out proven.
Cross-language parity held by the shared toolkit (10 codes, MAX_A2UI_ATTEMPTS=3,
envelope shape, prompt defaults, find_prior_surface).
