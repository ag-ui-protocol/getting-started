---
name: agui-dojo
description: >
  Run the AG-UI Dojo demo viewer locally and wire the AG-UI .NET SDK in as a dojo
  integration. USE FOR: starting the dojo app (apps/dojo), running the .NET dojo
  backend (AGUIDojoServer), registering or modifying the ag-ui-dotnet integration
  (agents.ts/menu.ts/env.ts/files.json), running the dojo Playwright e2e suite for
  the .NET integration (agUiDotnetTests), or understanding how dojo-e2e.yml runs it
  in CI. DO NOT USE FOR: generic Playwright validation of arbitrary pages (use
  agui-playwright-validate), or the docs site (use agui-dotnet-sdk-docs).
---

# AG-UI Dojo (.NET integration)

The **Dojo** is a Next.js "demo viewer" (`apps/dojo`) that showcases AG-UI protocol
features (agentic chat, generative UI, human-in-the-loop, shared state, etc.) against
many framework integrations. The AG-UI .NET SDK is one integration, id **`ag-ui-dotnet`**.

## Where the pieces live

| Piece | Path | Role |
|-------|------|------|
| Dojo app (frontend) | `apps/dojo` | Next.js viewer, runs on port **9999** |
| .NET backend | `sdks/dotnet/samples/AGUIClientServer/AGUIDojoServer/` | ASP.NET host exposing AG-UI endpoints, port **8023** |
| Agent registry | `apps/dojo/src/agents.ts` | `ag-ui-dotnet` → `HttpAgent` per feature |
| Menu / feature list | `apps/dojo/src/menu.ts` | integration id, name, enabled features |
| Env config | `apps/dojo/src/env.ts` | `aguiDotnetUrl` ← `AGUI_DOTNET_URL` (default `http://localhost:8023`) |
| Generated source viewer data | `apps/dojo/src/files.json` | generated, **committed** |
| Content generator | `apps/dojo/scripts/generate-content-json.ts` | builds `files.json` from `menu.ts` |
| Prep / run orchestrators | `apps/dojo/scripts/{prep,run}-dojo-everything.js` | install/build + start services |
| .NET e2e suite | `apps/dojo/e2e/tests/agUiDotnetTests/*.spec.ts` | Playwright tests |
| CI | `.github/workflows/dojo-e2e.yml` | suite `ag-ui-dotnet` (triggers on `sdks/dotnet/**`) |

## Run the dojo + .NET backend locally

From the repo root (the scripts shell out to `git rev-parse`):

```bash
pnpm install --no-frozen-lockfile

# 1) Prep: builds the .NET backend AND the dojo (use the stable ids)
node apps/dojo/scripts/prep-dojo-everything.js --only dojo,ag-ui-dotnet

# 2) Run: starts the dojo (9999) + AGUIDojoServer (8023) together, with LLMock env injected
node apps/dojo/scripts/run-dojo-everything.js --only dojo,ag-ui-dotnet
```

- Browse `http://localhost:9999/ag-ui-dotnet/feature/agentic_chat`.
- `prep` for `ag-ui-dotnet` runs `dotnet restore && dotnet build` on
  `AGUIDojoServer/AGUIDojoServer.csproj` in `sdks/dotnet/samples/AGUIClientServer`.
- `run` for `ag-ui-dotnet` runs `dotnet run --project AGUIDojoServer/AGUIDojoServer.csproj
  --urls "http://localhost:8023" --no-build` — **prep first or there's no build to run**.

Start just the .NET backend by hand (e.g. to debug):

```bash
cd sdks/dotnet/samples/AGUIClientServer
dotnet run --project AGUIDojoServer/AGUIDojoServer.csproj --urls "http://localhost:8023"
```

The backend resolves its `ChatClient` from configuration (`ChatClientAgentFactory.Initialize`):
`OPENAI_BASE_URL` (any OpenAI-compatible endpoint / LLMock), else `AZURE_OPENAI_ENDPOINT`
(Entra ID), else public OpenAI with `OPENAI_API_KEY`. `run-dojo-everything.js` injects
`OPENAI_BASE_URL=http://localhost:5555/v1` and `OPENAI_API_KEY=sk-mock` so it hits the LLMock.

## How the .NET SDK is registered as an integration

Each scenario is an AG-UI endpoint on the .NET host wired to a frontend feature. To add or
change a `.NET` dojo scenario, touch these in lockstep:

1. **Backend endpoint** — `AGUIDojoServer/Program.cs`: add `app.MapDojoEndpoint("/<feature>", ChatClientAgentFactory.Create…())`.
   Agent logic lives in `ChatClientAgentFactory.cs`.
2. **Agent mapping** — `apps/dojo/src/agents.ts` (`"ag-ui-dotnet"` block): add `<feature>: "<feature>"`
   inside `mapAgents`; each maps to `new HttpAgent({ url: \`${envVars.aguiDotnetUrl}/<feature>\` })`.
3. **Menu** — `apps/dojo/src/menu.ts` (`id: "ag-ui-dotnet"`): add the feature to `features`.
4. **Source viewer** — `apps/dojo/scripts/generate-content-json.ts` already maps `ag-ui-dotnet` to
   `Program.cs` + `ChatClientAgentFactory.cs`; then regenerate `files.json` (below).
5. **env.ts** — only edit if changing the URL/port; `aguiDotnetUrl`/`AGUI_DOTNET_URL` already exist.

Regenerate the committed source-viewer data after any `menu.ts` change:

```bash
cd apps/dojo && pnpm generate-content-json   # writes src/files.json
```

> ⚠️ CI job `check-generated-files` fails if `src/files.json` is stale. Always regenerate and
> commit it after editing `menu.ts` (or feature/README files).

## Run the .NET e2e suite locally

```bash
cd apps/dojo/e2e
pnpm install --ignore-scripts
pnpm exec playwright install --with-deps chromium   # first time only
# dojo (9999) + AGUIDojoServer (8023) must already be running (see above)
BASE_URL=http://localhost:9999 PLAYWRIGHT_SUITE=ag-ui-dotnet pnpm test -- tests/agUiDotnetTests
```

Tests navigate to `/ag-ui-dotnet/feature/<feature>` and drive the chat UI via page objects in
`apps/dojo/e2e/featurePages/`.

## How CI runs it (`dojo-e2e.yml`)

- Matrix suite `ag-ui-dotnet`: `test_path: tests/agUiDotnetTests`, `services: ["dojo", "ag-ui-dotnet"]`,
  `wait_on: http://localhost:9999,tcp:localhost:8023`.
- Triggers on `pull_request`/`push` paths including **`sdks/dotnet/**`**.
- Installs .NET `9.0.x` + `10.0.x`, runs `prep-dojo-everything.js --only` then
  `run-dojo-everything.js --only`, waits on the ports, then `pnpm test -- tests/agUiDotnetTests`.

## Gotchas

- **Ports are fixed**: dojo `9999`, AGUIDojoServer `8023`. The dojo's `AGUI_DOTNET_URL` must point
  to `http://localhost:8023` (default in `run-dojo-everything.js` and `env.ts`).
- **`--no-build` in run** means you must run the prep step first; otherwise the `dotnet run` fails.
- **LLMock, not a real LLM**: `OPENAI_BASE_URL=http://localhost:5555/v1` + `OPENAI_API_KEY=sk-mock`
  are injected. Backend tool-rendering scenarios also honor `AG_UI_MOCK_WEATHER=1` for determinism.
- **`BASE_URL` is required** — `playwright.config.ts` calls `process.exit(1)` if it's unset.
- **Stale `files.json`** is the most common CI failure after touching `menu.ts` — run
  `pnpm generate-content-json` and commit the result.
