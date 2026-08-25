---
name: agui-dotnet-feature-workflow
description: >
  Orchestrator/hub for implementing a feature or change in the AG-UI .NET SDK
  (sdks/dotnet). USE FOR: "what's the workflow", "what order do I do things in",
  "how do I implement a feature in the .NET SDK", starting any non-trivial
  AG-UI .NET SDK change, planning the end-to-end steps and definition-of-done
  (code + AOT serialization + client/server mapping + unit/integration/cross-language
  tests + docs + PublicAPI + AGENTS.md sync). DO NOT USE FOR: the deep how-to of a
  single step — this skill ROUTES to focused siblings: adding wire types
  (agui-dotnet-wire-types), transport/encoding (agui-dotnet-transport), unit tests
  (agui-dotnet-unit-tests), integration tests (agui-dotnet-integration-tests),
  cross-language tests (agui-dotnet-cross-language-tests), porting from TS/Python
  (agui-cross-sdk-parity), adding a GettingStarted sample Step
  (agui-dotnet-sample-step), SDK docs (agui-dotnet-sdk-docs), AGENTS/Architecture
  sync (agui-dotnet-agents-sync), the dojo (agui-dojo), review
  (agui-dotnet-code-review).
---

# AG-UI .NET SDK — Feature Workflow (Orchestrator)

This is the **hub** skill. Given a request to build or change a feature in the AG-UI
.NET SDK (`sdks/dotnet/`), it lays out the correct end-to-end order and **routes the
depth of each step to a focused sibling skill**. It does not duplicate their content.

The SDK has a multi-artifact **definition of done**. An agent working ad hoc forgets
artifacts — most often cross-language parity, docs, `AGENTS.md`/`docs/architecture.md` sync,
and `PublicAPI.Unshipped.txt`. Use this skill to avoid that.

## Package map

`sdks/dotnet/src/`:

| Package | Responsibility |
|---|---|
| `AGUI.Abstractions` | Wire types: events, messages, tools, capabilities, `AGUIJsonSerializerContext` |
| `AGUI.Formatting` | JSON formatter + SSE encode/decode |
| `AGUI.Protobuf` | Protobuf encoding of the protocol |
| `AGUI.Client` | `AGUIChatClient` (`IChatClient`) + transport negotiation |
| `AGUI.Server` | Hosting-agnostic agent-side conversion (`ChatResponseUpdate` → events) |

ASP.NET hosting glue lives in `samples/AGUI.Samples.Shared` (not a `src/` package).
`sdks/dotnet/AGENTS.md` and `docs/architecture.md` are the canonical description of
the layout and conventions (kept current via `agui-dotnet-agents-sync`); `AGUI.slnx`
is the ground truth if you need to re-derive the package list.

## Build & test commands

```bash
# from sdks/dotnet/
dotnet build sdks/dotnet/AGUI.slnx        # whole solution
dotnet test  tests/AGUI.Abstractions.UnitTests/   # per-project, fast feedback
```

`Directory.Build.props` **treats warnings as errors**, and `PublicApiAnalyzers` is on
for every `src/` project with a `PublicAPI.Shipped.txt`. **The build fails if you skip
the AOT serialization wiring or forget `PublicAPI.Unshipped.txt`** — these are not
optional polish steps, they are enforced.

## Definition of done (feature checklist)

- [ ] Wire contract understood (matched against TS/Python reference if wire-affecting)
- [ ] Type/behavior implemented in the **right package** (see map)
- [ ] AOT serialization wired (`[JsonSerializable]` in `AGUIJsonSerializerContext`, converter case, `[JsonPropertyName]`)
- [ ] Client/server mapping updated (`AGUI.Client` event→update and/or `AGUI.Server` update→event)
- [ ] Unit tests (serialization round-trip + behavior)
- [ ] Integration tests (full pipeline) if it crosses the HTTP/SSE boundary
- [ ] Cross-language parity tests if wire-affecting
- [ ] `PublicAPI.Unshipped.txt` updated for every changed public member
- [ ] Docs updated (docs.ag-ui.com / SDK docs) if user-facing
- [ ] `AGENTS.md` / `docs/architecture.md` synced if structure/recipe changed
- [ ] `dotnet build sdks/dotnet/AGUI.slnx` and relevant `dotnet test` projects green

## Ordered workflow → route each step

Do the steps **in this order**. Skip a step only if it genuinely doesn't apply
(e.g. a non-wire-affecting internal refactor skips cross-language parity).

1. **Understand the wire contract.** Read the TypeScript (and Python) reference for
   the type/behavior so the .NET shape matches the spec. Porting an existing feature
   from another SDK? → **`agui-cross-sdk-parity`**.

2. **Implement the type/behavior in the right package.**
   - New/changed wire type (event, message, tool, capability) → **`agui-dotnet-wire-types`**
     (covers the `AGUI.Abstractions` recipe: class in `Events/`, `AGUIEventTypes`
     constant, converter case, AOT registration, `PublicAPI.Unshipped.txt`).
   - New/changed transport or encoding (SSE, protobuf, formatter) →
     **`agui-dotnet-transport`** (`AGUI.Formatting`, `AGUI.Protobuf`).

3. **Wire AOT serialization.** Every protocol type goes through
   `AGUIJsonSerializerContext` — no reflection. `agui-dotnet-wire-types` has the
   per-type recipe; the build enforces it.

4. **Update client/server mapping.** Server-side `ChatResponseUpdate` → event lives in
   `AGUI.Server`; client-side event → `ChatResponseUpdate` lives in `AGUI.Client`
   (`EventStreamConverter`, builders). Update both directions if the wire shape changed.

5. **Unit tests** (round-trip + behavior) → **`agui-dotnet-unit-tests`**.

6. **Integration tests** (HTTP + SSE pipeline, `WebApplicationFactory`,
   `AGUIChatClient`) → **`agui-dotnet-integration-tests`**. Required when the change
   crosses the transport boundary.

7. **Cross-language parity tests** (if wire-affecting) →
   **`agui-dotnet-cross-language-tests`** (`tests/AGUI.CrossLanguage.IntegrationTests`,
   `CrossLanguage.TestServer`, `CrossLanguage.Vitest`). This is the step agents most
   often forget — .NET must agree with TS/Python on the bytes.

8. **Update `PublicAPI.Unshipped.txt`** for every changed public member, in each
   affected `src/` project. The PublicAPI analyzer fails the build otherwise.

9. **Docs** (user-facing change) → **`agui-dotnet-sdk-docs`** (docs.ag-ui.com).

10. **Sync `AGENTS.md` / `docs/architecture.md`** if you changed structure, recipes, or
    commands → **`agui-dotnet-agents-sync`**. Fix stale package references while here.

11. **Build + test green.** `dotnet build sdks/dotnet/AGUI.slnx`, then the relevant
    `dotnet test <project>` (unit + integration + cross-language as applicable).

12. **Validate & review.** Run/inspect in the dojo → **`agui-dojo`**; manual UI/docs
    checks → **`agui-playwright-validate`**; review the change → **`agui-dotnet-code-review`**.

## Routing table (quick reference)

| Step / need | Sibling skill |
|---|---|
| Add/modify a wire type | `agui-dotnet-wire-types` |
| Add/modify transport or encoding | `agui-dotnet-transport` |
| Port a feature from TS/Python | `agui-cross-sdk-parity` |
| Write unit tests | `agui-dotnet-unit-tests` |
| Write integration tests | `agui-dotnet-integration-tests` |
| Write cross-language tests | `agui-dotnet-cross-language-tests` |
| Add a GettingStarted sample Step (Server/Client pair) | `agui-dotnet-sample-step` |
| Update SDK docs site | `agui-dotnet-sdk-docs` |
| Keep AGENTS.md / docs/architecture.md current | `agui-dotnet-agents-sync` |
| Run/validate in the dojo | `agui-dojo` |
| Manual UI/docs validation | `agui-playwright-validate` |
| Review the change | `agui-dotnet-code-review` |

> The depth of each step lives in the sibling skill it routes to; fall back to the
> recipes in `AGENTS.md` and the deep content in `docs/architecture.md` for anything a
> sibling doesn't cover.

## ❌ Anti-patterns

1. **Don't stop at "it compiles and unit tests pass."** Wire-affecting changes are not
   done until cross-language parity tests and docs are updated.
2. **Don't put protocol or server code in a sample.** It belongs in `src/`; the server is
   `AGUI.Server`, hosting glue is in `samples/AGUI.Samples.Shared`, and no `src/` project
   references ASP.NET.
3. **Don't skip `PublicAPI.Unshipped.txt` or AOT registration** "to fix later" — the
   warnings-as-errors build will block you immediately.
4. **Don't do the deep work here.** This skill routes; the depth lives in the sibling
   skills. Open the relevant one before implementing a step.
