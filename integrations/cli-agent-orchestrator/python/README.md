# CLI Agent Orchestrator — AG-UI Python example server

This directory contains the Python example server for the CLI Agent Orchestrator
(CAO) integration with the AG-UI protocol.

## Overview

The example server is a standalone FastAPI application that serves four Dojo
features. It ships **two keyless backends behind one interface**, selected
automatically (and overridable via `CAO_AGUI_MODE`):

- **projection** — the default when the optional `cao` extra is installed. Each
  route is a thin call into CAO's merged run plane
  (`cli_agent_orchestrator.services.agui.run_plane.run_plane_stream`), the single
  authority for frame shape and the interrupt lifecycle. Highest fidelity; the
  route only supplies the deterministic fleet fixtures a live CAO server would
  supply from real processes.
- **mock** — a zero-dependency fallback built only on `ag_ui.core` /
  `ag_ui.encoder`, with **no `cli-agent-orchestrator` dependency**. A bare
  `uv sync` (and the keyless CI e2e) runs every feature anywhere.

Both backends satisfy the same fail-closed contract suite.

| Endpoint | Feature | Description |
|----------|---------|-------------|
| `POST /agentic-chat` | Agentic Chat | A baseline fleet run |
| `POST /shared-state` | Shared State | Fleet state snapshot (+ delta in projection) |
| `POST /human-in-the-loop` | Human in the Loop | A declarative approval affordance |
| `POST /agentic-generative-ui` | Agentic Generative UI | The fleet's own lifecycle as a live step list |
| `POST /interrupt` | Interrupt (flagship) | The full approve/deny interrupt round-trip |
| `GET /health` | — | Liveness (`{"status":"ok"}`) |
| `GET /` | — | Metadata + endpoint map |

## Getting started

### Prerequisites

- Python 3.11–3.13
- [uv](https://docs.astral.sh/uv/)

### Install & run

```bash
cd examples

# Mock backend (zero-dependency, keyless):
uv sync
uv run dev

# Projection backend (CAO's real run plane):
uv sync --extra cao
uv run dev
```

The server listens on `http://0.0.0.0:8027` by default. Environment variables:

- `PORT` — listen port (default `8027`)
- `CAO_AGUI_MODE` — `auto` (default: projection if the `cao` extra is importable,
  else mock), `projection`, or `mock`. Forcing `projection` without the `cao`
  extra installed is an error.
- `CORS_ALLOW_ORIGINS` — comma-separated origins (default `*` for local dev;
  credentials are enabled only for explicit non-wildcard origins)

> `uv run dev` does **not** auto-reload; restart the process after editing the
> server code.

## Backend selection

```
CAO_AGUI_MODE=auto        # projection if CAO importable, else mock (default)
CAO_AGUI_MODE=projection  # force CAO run plane (requires the `cao` extra)
CAO_AGUI_MODE=mock        # force the zero-dependency backend
```

The `cao` extra resolves `cli-agent-orchestrator[agui]>=2.4.1,<3` from PyPI (see
`examples/pyproject.toml`); AG-UI Phase 2 shipped in `2.4.1` on 2026-08-04.

## Agentic generative UI — the fleet's own lifecycle as the step list

The Dojo's `agentic_generative_ui` building block renders from the agent's
**evolving state** rather than per tool call. Its contract is just
`state.steps[] = {description, status}`, with `status` one of `pending` or
`completed`.

Every other integration fills that with a plan an LLM invented — the shared
page's own suggestions are *"a plan to go to mars in 5 steps"*. CAO does not have
to invent one. A fleet of real OS processes already moves through discrete,
observable steps, and the six record primitives already name them, so each step
maps 1:1 onto real orchestration work:

| Step | Record kind |
|------|-------------|
| Launching `code_supervisor` on `mock_cli` | `launch` |
| Delegating implementation to the developer worker | `handoff` |
| `developer` editing `src/config.ts` | `file_mod` |
| Handing off to the reviewer for correctness | `handoff` |
| Retiring the developer terminal | `completion` |

In **projection** mode the same records also drive their genuine run-plane
frames: `STEP_STARTED`/`STEP_FINISHED` for the launch and completion,
`TOOL_CALL_*` for each handoff, and an RFC-6902 `STATE_DELTA` for the file
modification.

**Known constraint, stated plainly.** The run plane calls `snapshot_fn` once per
run, so a single projection run carries one `STATE_SNAPSHOT`; step statuses
therefore advance one step per turn rather than animating inside a turn. A
within-run progressive projection needs a *generic* state-delta projection in CAO
(today only `file_mod` maps to `STATE_DELTA`), which is
[awslabs/cli-agent-orchestrator#519](https://github.com/awslabs/cli-agent-orchestrator/issues/519)
territory rather than this integration's. **Mock** mode emits the full
progressive snapshot sequence the shared page was built for, and mock is what the
Dojo launcher, the keyless CI matrix and the hosted demo all pin — so the visible
demo animates.

Descriptions are metadata only: they name agents, providers and paths, never
command output or message bodies.

## Interrupt lifecycle

The `/interrupt` endpoint demonstrates the complete AG-UI interrupt protocol —
the round-trip no API-wrapper integration can do:

1. **Initial request** (no `resume[]`) → a metadata-only `STATE_SNAPSHOT`, then
   `RUN_FINISHED` with `outcome.type = "interrupt"` carrying one `Interrupt`.
2. **Resume request** (with `resume[]`) → the user's decision is normalized to an
   approve/deny (approve = a resolved slot; deny = `cancelled`) and the run
   finishes with `outcome.type = "success"`.

**Privacy boundary:** message bodies and raw command text never reach the wire —
interrupts carry metadata only (`reason`, `message`, `metadata`). This is
asserted by the contract suite.

## Tests

Mode-aware, fail-closed contract tests (no secrets, independent of the Dojo
frontend):

```bash
uv run --extra test pytest                    # mock backend
uv sync --extra cao --extra test && pytest    # projection backend
```

## Related

- [AG-UI Protocol SDK](../../../../sdks/python/) — core protocol types and encoder
- [TypeScript client](../../../cli-agent-orchestrator/typescript/) — the corresponding TS client package
- [ARCHITECTURE.md](../ARCHITECTURE.md) — the L0–L3 construct model and wire contract
