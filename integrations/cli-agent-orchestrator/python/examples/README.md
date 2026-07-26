# CAO Dojo Example Server

Keyless CLI Agent Orchestrator (CAO) example server for the AG-UI protocol Dojo.
Serves five features — `agentic_chat`, `shared_state`, `human_in_the_loop`,
`agentic_generative_ui`, and the flagship `interrupt` — on port **8027**
(`/health`, CORS). See the
[parent README](../README.md) and [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Two keyless backends (auto-selected)

| Backend | When | Fidelity |
|---|---|---|
| **projection** *(default with `cao` extra)* | `uv sync --extra cao` | Thin projection over CAO's real merged run plane (`services.agui.run_plane`) — exercises CAO's actual Phase 2 code |
| **mock** *(zero-dependency fallback)* | bare `uv sync` | Self-contained frames (`ag_ui.core`/`encoder`) — no `cli-agent-orchestrator` dependency; used by the keyless CI e2e |

Selection is automatic (projection if the `cao` extra is installed, else mock).
Force with `CAO_AGUI_MODE=projection|mock`.

The `cao` extra resolves `cli-agent-orchestrator[agui]>=2.4.1,<3` from PyPI. AG-UI
Phase 2 shipped in **2.4.1** (2026-08-04), which publishes the `agui` extra, so no
VCS pin is needed. The upper bound guards the three modules the projection backend
imports directly — `services.agui.run_plane`, `services.agui.base`, and
`services.agui.handoff_approval` — against a major-version rename.

## Run

```bash
# mock backend (zero-dependency)
uv run dev

# projection backend (CAO's real run plane)
uv sync --extra cao && uv run dev
```

## Test

```bash
uv run --extra test pytest                  # tests the mock backend
uv sync --extra cao --extra test && pytest  # tests the projection backend
```

Both modes assert the shared lifecycle + interrupt approve/deny + privacy
boundary; backend-specific frames are asserted per mode.

### Dojo e2e (Node 22)

The Playwright suite (`apps/dojo/e2e/tests/caoTests`) must run on **Node 22**.
Playwright 1.52.0 loads TypeScript via `module.register()`, whose semantics
changed in Node 26; on 26 the loader deadlocks *before* `globalSetup`, with no
error and no stack — it looks like a hung test rather than a bad runtime.

The repo declares its Node major once, in `.node-version` at the root, and the
`dojo-e2e` workflow consumes it (`actions/setup-node` with
`node-version-file: ".node-version"`), so CI is pinned without any per-suite
configuration. For local runs, use whatever your version manager reads from that
file — for example `mise x node@22 -- …` — rather than a shell default, which may
resolve to `latest`.

Next compiles routes on first request, so warm the five feature routes **and**
`/api/copilotkit/cli-agent-orchestrator` before running the suite; a cold
Turbopack compile exceeds the specs' budgets and is indistinguishable from a real
failure.
