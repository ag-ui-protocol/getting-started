---
name: agui-dotnet-sdk-docs
description: >
  Author, update, and validate the AG-UI .NET SDK documentation pages on the
  docs.ag-ui.com Mintlify site (under docs/). USE FOR: adding or editing a
  ".NET SDK" docs page (sdk/dotnet/**/*.mdx), wiring it into the docs.json
  ".NET" nav group and global anchor, running the docs site locally with
  mintlify dev, previewing/validating rendered .NET pages, checking the .NET
  sidebar anchor/icon. DO NOT USE FOR: in-repo dotnet markdown such as
  sdks/dotnet/AGENTS.md or docs/architecture.md (use agui-dotnet-agents-sync);
  TypeScript/Python docs pages; product code, tests, or wire types.
---

# AG-UI .NET SDK — Docs Site Authoring

The published docs at `docs.ag-ui.com` are a **Mintlify** project rooted at
`docs/`. The .NET SDK section is a sibling of the TypeScript and Python
sections. Pages live as `.mdx` files and are wired into navigation through
`docs/docs.json`. Get the location or the nav wrong and the page renders nowhere
or breaks the build.

## Where .NET docs live

```
docs/
  docs.json                         # nav + global anchors (single source of truth)
  sdk/dotnet/
    abstractions/{overview,types,events,multimodal-inputs}.mdx   # AGUI.Abstractions
    client/{overview,chat-client,transport}.mdx                  # AGUI.Client
    hosting/{overview,endpoints,extensibility}.mdx               # AGUI.Hosting.AspNetCore
  sdk/js/**, sdk/python/**          # sibling sections — the style reference
```

The `.NET` nav group in `docs.json` mirrors the `js` and `python`
groups: subgroups named after the packages
(`AGUI.Abstractions`, `AGUI.Client`, `AGUI.Hosting.AspNetCore`) each listing
page paths **without** the `.mdx` extension. A global anchor `.NET SDK`
points at `sdk/dotnet/abstractions/overview`. (The anchor icon and its CSS
treatment are already set up; this skill is about adding and editing pages, not
the anchor.)

## Page conventions (mirror the JS pages)

Study the JS sibling for any page you add — `docs/sdk/js/core/overview.mdx`,
`docs/sdk/js/client/*.mdx` — and keep the .NET page parallel in shape.

- **Frontmatter**: `title` (Title Case, e.g. `"Overview"`, `"AGUIChatClient"`)
  and `description` (one line). See `docs/sdk/dotnet/abstractions/overview.mdx`.
- **H1** names the package or type (`# AGUI.Abstractions`, `# AGUIChatClient`),
  matching the JS H1 convention (`# @ag-ui/core`).
- Install fence uses `dotnet add package AGUI.*` (JS uses `npm install @ag-ui/*`).
- Cross-links are root-absolute: `/sdk/dotnet/abstractions/types#runagentinput`.
- Mintlify components are in scope (`<Note>`, `<Card>`, `<Tip>`, etc.) — use the
  same ones the surrounding .NET/JS pages use; don't introduce new patterns.

## Adding or editing a page

1. Create/edit `docs/sdk/dotnet/<group>/<page>.mdx` with the frontmatter + H1
   conventions above, modeled on the JS sibling page.
2. Register it in `docs/docs.json` under the correct `.NET` subgroup, in the
   intended order, as `"sdk/dotnet/<group>/<page>"` (no extension).
3. If it is a new top-level entry point, update the `.NET SDK` global anchor
   href in `docs.json` too.
4. **Restart `mintlify dev`** — `docs.json` changes are read at startup only.

## Local preview

```bash
cd docs
npm install                       # first run only; installs Mintlify locally
node_modules/.bin/mintlify dev --port=4000   # or: npm run dev (defaults to 4000)
```

Known, harmless quirks — do not chase these:

- **`docs.json` changes need a server restart**; `.mdx` edits hot-reload.
- The CLI prints React **"invalid hook call"** warnings on startup — noise.
- Some **pre-existing non-.NET pages** have MDX parse errors. If the page you
  touched isn't one of them, the error isn't yours — confirm by URL.

## Validation loop (Playwright MCP)

Use the generic Playwright-MCP technique from the `agui-playwright-validate`
skill; the checks below are the docs-specific assertions. Run them against the
running dev server (e.g. `http://localhost:4000`).

For **every .NET page you added or changed**:
1. Navigate to its localhost URL (`/sdk/dotnet/<group>/<page>`).
2. Assert **HTTP 200** (not a 404 / "page not found" body).
3. Assert the rendered **H1/heading matches** the page's intended title.
4. Assert **zero console errors** for that page load.

For the **nav** (do once):
5. Confirm the new page appears in the left sidebar under the right `.NET`
   subgroup, in the expected order, and that the page renders (screenshot if a
   human needs to eyeball a visual detail).

## Cleanup

- Remove any Playwright artifacts (screenshots, traces) the validation produced.
- Stop the `mintlify dev` process to free the port when finished.

## ❌ Critical anti-patterns

1. **Never add an `.mdx` without registering it in `docs.json`** — unregistered
   pages don't appear in the nav (and the `.NET` group is the only correct home
   for .NET pages, as a sibling of `js`/`python`).
2. **Never expect a `docs.json` edit to hot-reload** — restart `mintlify dev` or
   you'll validate stale nav.
3. **Never invent page structure** — mirror the JS sibling's frontmatter, H1,
   and component usage instead.
4. **Don't "fix" the React hook warnings or pre-existing non-.NET MDX errors** —
   they're out of scope; only the .NET page you touched must render clean.

## Files to mine

`docs/docs.json` (the `.NET` nav group + the `.NET SDK` global anchor),
`docs/sdk/dotnet/**/*.mdx`, the JS reference `docs/sdk/js/**/*.mdx`,
`docs/package.json`.
