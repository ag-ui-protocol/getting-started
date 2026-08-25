---
name: agui-dotnet-agents-sync
description: >
  Keep the AG-UI .NET SDK docs (sdks/dotnet/AGENTS.md and docs/architecture.md) in
  sync with the real code tree after structural changes. USE FOR: "update
  AGENTS.md / docs/architecture.md", "check the dotnet docs are current", verifying
  docs after a .NET SDK refactor (package rename, added/removed project,
  changed endpoint pattern, new/renamed test project, sample step added, new
  convention). DO NOT USE FOR: writing product code or tests (follow AGENTS.md
  itself), Python/TypeScript SDK docs, or generic markdown editing unrelated to
  the dotnet SDK structure.
---

# AG-UI .NET SDK — Docs Sync

`sdks/dotnet/AGENTS.md` (coding instructions) and `sdks/dotnet/docs/architecture.md`
(design overview) describe the SDK's structure, naming, and conventions. They
drift silently after refactors because nothing fails the build when prose goes
stale. This skill reconciles them against the live tree.

> Typical drift this catches: a package rename, a moved/removed project, a changed
> endpoint pattern, or a new sample step that the prose never caught up with. An agent
> that edits these files from memory re-introduces the same kind of drift, so always
> derive the truth from the tree first.

## Process

1. **Establish ground truth from the tree, not from the doc.** The authoritative
   source is `sdks/dotnet/AGUI.slnx` plus the folder listing — never the prose
   you are about to edit.
   - Projects: read `<Project Path=...>` entries from `AGUI.slnx`.
   - Folders: `Get-ChildItem src,tests,samples -Directory`.
   - Samples/steps: list `samples/GettingStarted/Step*` to get the real range.
2. **Drift scan — diff each doc claim against the tree.** For every concrete
   claim in AGENTS.md / docs/architecture.md, confirm it against ground truth:
   - Project & package names exist in `AGUI.slnx` (and in `src/`, `tests/`).
   - Symbols the docs name still exist: `Select-String -Path src\*\*.cs,samples\*\*.cs -Pattern "<Symbol>"`.
   - Renamed/removed symbols are GONE everywhere: grep the repo for the old
     name (e.g. `AGUI.Hosting.AspNetCore`, `TypedResults.ServerSentEvents`); a
     hit in prose-only is the drift to fix.
3. **Fix surgically.** Edit only the stale lines. Match existing tone, tables,
   and code-fence style. Do not restructure or invent conventions.
4. **Verify.** Re-grep every symbol/name you wrote to confirm it exists in the
   tree. Optionally `dotnet build` from `sdks/dotnet/` if you touched code-style
   or build claims.

## Drift checklist (the claims that rot)

| Doc claim | Reconcile against |
|---|---|
| **src package list / names** | `AGUI.slnx` `/src/` folder + `src/` dirs |
| **Package dependency table & framework refs** | `grep Microsoft.AspNetCore src\*\*.csproj` (must be empty — no src project references ASP.NET) |
| **Where ASP.NET glue lives** | `samples/AGUI.Samples.Shared` (the only `FrameworkReference Microsoft.AspNetCore.App`) |
| **Test-project table & count** | `AGUI.slnx` `/tests/` + `tests/` dirs |
| **Sample step range / count** | `samples/GettingStarted/Step*` listing |
| **Endpoint pattern code** | actual sample `Program.cs` + `samples/AGUI.Samples.Shared` |
| **Project layout bullet list** | `src/`, `tests/`, `samples/` dirs |
| **Code-style / naming / serialization rules** | `Directory.Build.props/.targets`, `Directory.Packages.props`, source |
| **PublicAPI workflow** | presence of `PublicAPI.*.txt` in each `src/` project |

## Deriving ground truth (commands, not a snapshot)

Don't trust any embedded list (including this skill). Re-derive the current state
from the tree every time:

```powershell
# from sdks/dotnet/
Select-String -Path AGUI.slnx -Pattern '<Project Path'   # all projects
Get-ChildItem src,tests,samples -Directory               # folders
Get-ChildItem samples/GettingStarted -Directory -Filter Step*  # sample step range
Select-String -Path src\*\*.csproj -Pattern Microsoft.AspNetCore  # must be empty (no ASP.NET in src/)
```

A couple of durable facts that are easy to get wrong: the server package is
`AGUI.Server` (ASP.NET hosting glue lives only in `samples/AGUI.Samples.Shared`),
and the integration-test **project name** stays `AGUI.Hosting.AspNetCore.IntegrationTests`
even though its types are in namespace `AGUI.Server.IntegrationTests`. Everything else,
derive from the commands above.

## ❌ Critical anti-patterns

1. **Never edit the docs from memory or from the doc's own current text.** The
   stale prose is exactly what misleads you. Derive every name from `AGUI.slnx`
   and the folder listing first.
2. **Never rename a symbol in prose without grepping the whole tree** for the
   old name — a lingering reference (or an unchanged code fence) is silent drift.
3. **Don't invent conventions or restructure the docs.** Reconcile only what the
   tree proves changed; keep tables, tone, and code-fence style intact.
4. **Don't confuse a kept project name with a moved concept.** The integration
   test project is still `AGUI.Hosting.AspNetCore.IntegrationTests` even though
   the src package was renamed to `AGUI.Server`.

## Files to mine

`sdks/dotnet/AGENTS.md`, `sdks/dotnet/docs/architecture.md`, `sdks/dotnet/AGUI.slnx`,
`sdks/dotnet/Directory.Build.props`, `Directory.Build.targets`,
`Directory.Packages.props`, and the `src/`, `tests/`, `samples/` folder trees.
