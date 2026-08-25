---
name: agui-playwright-validate
description: >
  Manually validate a running web app or docs site with the Playwright MCP
  server — navigate pages, assert headings/text/status, check for console
  errors, hover/click to exercise interactions, take screenshots for human
  review, and verify visual details such as an icon's color in light vs dark
  mode by reading computed styles. USE FOR: "validate with Playwright", "open
  the browser and check", visually verifying a UI or docs change, confirming a
  CSS/SVG/icon edit rendered, checking a page for console errors, comparing
  light/dark mode appearance. DO NOT USE FOR: writing automated unit/E2E test
  files (dojo e2e lives in agui-dojo); docs-site content/structure checks
  specific to the .NET SDK docs (use agui-dotnet-sdk-docs). INVOKES:
  browser_navigate, browser_snapshot, browser_take_screenshot, browser_evaluate,
  browser_hover, browser_click, browser_console_messages Playwright MCP tools.
---

# Playwright MCP Validation

Technique skill for **manually** validating a live web app or docs site through
the `playwright` MCP server (configured in this repo's `.mcp.json` as
`@playwright/mcp@latest`). The agent calls the `browser_*` MCP tools directly —
**never write or wrap them in scripts.** This captures the validated workflow
used to verify the docs sidebar icon and dojo pages, including the gotchas an
agent otherwise rediscovers slowly.

## When to reach for this

Use Playwright-MCP validation for what a unit test *can't* give you:

- Confirming something actually **renders** (layout, an icon/SVG, a color).
- Verifying **interactive states** — hover, click, theme toggle, dialogs.
- Catching **console errors** that only surface in a real browser.
- Producing a **screenshot for a human** to eyeball a visual change.

If a deterministic assertion in code would suffice, write a test instead.

## Prerequisites

- The app/docs site must be **running**. If you start a dev server, note the
  port and URL; you own stopping it during cleanup.
- The `playwright` MCP server must be connected (its `browser_*` tools appear in
  your tool list). On first use it may install a browser — allow time.

## Validation loop

Cheap-to-expensive. Stop as soon as you have a confident answer.

1. **Navigate** — `browser_navigate` to the page URL.
2. **Snapshot** — `browser_snapshot` returns the **accessibility tree** (text +
   roles + refs). This is token-cheap and the primary assertion surface. Confirm
   the expected heading/text/landmark is present here *before* screenshotting.
3. **Console** — `browser_console_messages` and assert **0 errors** (warnings may
   be acceptable; judge by context). Do this on every page you validate.
4. **Screenshot** — `browser_take_screenshot` only when a human needs to see it,
   or when a visual detail can't be asserted from the tree (color, spacing,
   image rendering).
5. **Report** pass/fail per check with the concrete evidence (the heading text
   you saw, the console count, the computed color).

> ❌ Don't screenshot-diff when an accessibility snapshot already proves the
> text/structure is correct — the snapshot is cheaper and more reliable.

## Techniques that matter

### Read computed styles for color/visual checks

Screenshots can't be asserted programmatically. Use `browser_evaluate` to read
`getComputedStyle` and **compare elements** rather than hard-coding a color
string (which differs across themes):

```js
() => {
  const icon = document.querySelector('aside a.active svg');
  const text = document.querySelector('aside a.active span');
  return {
    icon: getComputedStyle(icon).color,
    text: getComputedStyle(text).color,
    matches: getComputedStyle(icon).color === getComputedStyle(text).color,
  };
}
```

Asserting `icon.color === text.color` survives a theme change; asserting
`color === 'rgb(...)'` does not.

### Light/dark mode

Most frameworks toggle a `.dark` (or `data-theme`) class on `<html>`. Toggle it
and re-check computed styles in both modes:

```js
() => { document.documentElement.classList.toggle('dark'); }
```

Prefer clicking the site's real theme switch when one exists (so you exercise the
actual code path); fall back to toggling the class only to read styles.

### Hover needs a target

`browser_hover` requires an **element/selector target** — a bare ref with no
element errors. Pass the element described in the latest snapshot.

### Force a hard reload for CSS/SVG/asset changes

A soft `browser_navigate` can serve cached CSS/SVG/JS, so your edit "doesn't
appear." Bypass the cache: navigate to a **cache-busted URL** (`?v=<timestamp>`)
or evaluate `location.reload(true)` after the asset changed.

> ❌ Don't trust a soft reload when validating a changed stylesheet, SVG, or
> bundled asset — you'll validate the stale version and report a false pass/fail.

### Overlays intercept clicks

If a click/hover fails with "intercepted" or "not clickable," a dialog, cookie
banner, or menu is on top. Press **Escape** (`browser_press_key` Escape) to
dismiss it, then retry.

### Element ids set via evaluate are ephemeral

Anything you inject with `browser_evaluate` (an `id`, a marker class) can be
**lost on re-render/navigation**. Re-query from a fresh snapshot each step
rather than relying on a handle you set earlier.

## Cleanup discipline

Before finishing, leave no trace:

- Delete screenshot artifacts you generated and the **`.playwright-mcp/`**
  output folder.
- **Stop any dev server / free the port** you started for validation.
- Don't leave a browser context or toggled theme state that misleads later runs.

> ❌ Don't finish a validation task with leftover screenshots, a running dev
> server, or a `.playwright-mcp/` folder committed into the repo.

## Anti-patterns

- ❌ Writing a script that calls Playwright — use the `browser_*` MCP tools
  directly.
- ❌ Reporting "looks fine" from a screenshot without a snapshot/console-error
  assertion to back it.
- ❌ Hard-coding an expected `rgb(...)` for a color check instead of comparing
  to a sibling element across themes.
- ❌ Soft-reloading after a CSS/asset edit and trusting the result.
- ❌ Leaving artifacts, a `.playwright-mcp/` folder, or a dev server running.
