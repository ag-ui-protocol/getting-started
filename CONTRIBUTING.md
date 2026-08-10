# Contributing to AG-UI

Thanks for checking out AG-UI! Whether you're here to fix a bug, ship a feature, improve the docs, or just figure out how things work—we're glad you're here.

Here's how to get involved:

---

## Have a Question or Ran Into Something?

Pick the right spot so we can help you faster:

- **I want to contribute [Fixes / Feature Requests]** → [GitHub Issues](https://github.com/ag-ui-protocol/ag-ui/issues)
- **"How do I...?** → [Discord](https://discord.gg/Jd3FzfdJa8) → `#-💎-contributing`
- **Introduce Yourself** → [Discord](https://discord.gg/Jd3FzfdJa8) → `🤝-intro`

---

## Want to Contribute Code?

First, an important plea:
**Please PLEASE reach out to us first before starting any significant work on new or existing features.**

We love community contributions! That said, we want to make sure we're all on the same page before you start.
Investing a lot of time and effort just to find out it doesn't align with the upstream project feels awful, and we don't want that to happen.
It also helps to make sure the work you're planning isn't already in progress.

If you'd confirmed that the **[x]** work hasn't been started yet, please file an issue first: https://github.com/ag-ui-protocol/ag-ui/issues

1. **Find Something to Work On**
   Browse open issues on [GitHub](https://github.com/ag-ui-protocol/ag-ui/issues).
   Got your own idea? Open an issue first so we can start the discussion.

2. **Ask to Be Assigned**
   Comment on the issue and tag a code owner:
   → [Code Owners](https://github.com/ag-ui-protocol/ag-ui/blob/main/.github/CODEOWNERS)

3. **Get on the Roadmap**
   Once approved, you'll be assigned the issue, and it'll get added to our [roadmap](https://github.com/orgs/ag-ui-protocol/projects/1).

4. **Coordinate With Others**
   - If you're collaborating or need feedback, start a thread in `#-💎-contributing` on Discord
   - Or just DM the assignee directly

5. **Open a Pull Request**
   - When you're ready, submit your PR
   - In the description, include: `Fixes #<issue-number>`
     (This links your PR to the issue and closes it automatically)

6. **Review & Merge**
   - A maintainer will review your code and leave comments if needed
   - Once it's approved, we'll merge it and move the issue to "done."

**NOTE:** All community integrations (ie, .NET, Golang SDK, etc.) will need to be maintained by the community member who made the contribution.

---

## Toolchain

This repository is developed and tested on the Node version in `.node-version` at the root. `fnm` reads it directly and resolves a bare major, so `fnm use` in the repository root gets you the right Node. `nvm` reads only `.nvmrc`, so pass the version through (`nvm use "$(cat .node-version)"`). `nodenv` and `asdf` read `.node-version` too — `asdf` only with `legacy_version_file = yes` in `~/.asdfrc` — but both resolve it to an exactly-installed version name, so under plain `nodenv` a bare major does not resolve at all: install an exact version (`nodenv install 22.11.0`) and either add the [`nodenv-aliases`](https://github.com/jasonkarns/nodenv-aliases) plugin or set `NODENV_VERSION`.

In CI, all 12 `actions/setup-node` steps read that file via `node-version-file` rather than naming a version inline. Nothing enforces that automatically yet, so a new step that types a version in would not be caught — if you are adding one, copy an existing step rather than writing the input from scratch. The same is true of pnpm, which is pinned two different ways today: 9 of 11 `pnpm/action-setup` steps pin `version:` inline and 2 rely on `package.json#packageManager`.

The Python build toolchain is pinned the same way, in [`.github/python-toolchain.env`](.github/python-toolchain.env), but that one *is* enforced — `scripts/release/verify-python-toolchain-pins.sh` fails CI when a workflow's literal disagrees with the record. Closing the same gap for Node and pnpm is tracked in [PNI-280](https://linear.app/copilotkit/issue/PNI-280); see Step 7's Python note for the enforced version of this pattern.

To bump the Node major, edit `.node-version` — every `actions/setup-node` step follows it automatically. Then review `publish-release.yml`'s npm-OIDC workaround, which exists only because the npm bundled with Node 22 cannot use OIDC trusted publishing, so a later major should probably delete it. Nothing will remind you about that one, so it is written down here.

None of this is `package.json#engines.node`. The root manifest is private and never published, so its `>=18` is a floor on installs *in this repository* — and it is what `node-version-file: "package.json"` used to resolve before this was centralized. The published `@ag-ui/*` packages mostly declare no engines range at all, so changing the root value is not a consumer-compatibility decision.

---

## Step-by-Step Guide to Adding an Integration PR

This guide walks you through everything needed to submit an integration PR to AG-UI. It covers adding the integration code, examples, dojo configuration, end-to-end tests, and CI setup.

Use existing integrations in `integrations/` (e.g., `integrations/adk-middleware/` or `integrations/langgraph/`) as reference implementations throughout.

### Step 1: Add Your Integration Folder

Your integration code goes inside the `integrations/` folder, under a subfolder named after your integration (e.g., `integrations/my-framework/`).

- **Language subfolder** — Organize by language. For example, if your integration is in Python, place it under `integrations/my-framework/python/`. If it supports multiple languages (e.g., Python and Rust), use separate subfolders like `python/` and `rust/`.
- **Examples subfolder** — Include an `examples/` directory inside your language folder (e.g., `integrations/my-framework/python/examples/`). The dojo examples must live here, but you can include additional examples as well.
- **TypeScript client folder (required)** — No matter what language the integration is in, you must also include a `typescript/` folder. At minimum, this contains the TypeScript client code that re-exports the HTTP agent. You can copy this from an existing integration like `integrations/adk-middleware/typescript/` as a reference. It includes a `package.json`, TypeScript config, and the client code itself. If your framework natively supports TypeScript, the full TypeScript implementation should also live in this package.

**Example structure:**
```
integrations/my-framework/
├── python/
│   ├── examples/          # Dojo examples live here
│   │   ├── pyproject.toml
│   │   └── ...
│   ├── pyproject.toml     # Integration package
│   └── ...
└── typescript/
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── index.ts       # Re-exports the HTTP agent
```

### Step 2: Register Your Integration in the Dojo

You need to update three files inside `apps/dojo/src/` to make the dojo aware of your integration:

- **`agents.ts`** — Add an entry for your integration. The **object key** you choose is important because it must match exactly in the other configuration files. If your framework supports multiple variants — different languages, runtimes, or transport modes — each variant gets its own separate entry. For example, LangGraph has entries for LangGraph Platform (Python), LangGraph FastAPI (Python), and LangGraph TypeScript.
- **`menu.ts`** — Add your integration to the sidebar menu. The **`id`** must match the object key you used in `agents.ts`. The **`name`** is the human-readable display label shown in the left sidebar and does not need to match the ID. Each entry also defines which features it supports (e.g., `agentic_chat`, `human_in_the_loop`, `agentic_generative_ui`). This file is the single source of truth for integration configuration.
- **`env.ts`** — Define the environment variable for your agent's hosted URL (one per agent). This is how the dojo knows where to reach your agent at runtime. The default should match whatever host/port your example code uses.

### Step 3: Configure the Agent Mapping

Each entry in `agents.ts` contains a mapping of feature keys. This is typically a one-to-one mapping where each key corresponds to one agent. For most integrations, this is simple — one feature maps to one agent name. If your framework handles multiple agents talking together, there may be multiple agents listed, but each still gets its own entry.

### Step 4: Set Up Environment Variables

Your example code must:

- **Bind to host `0.0.0.0`** (or be overridable via the `HOST` environment variable)
- **Respect the `PORT` environment variable** — when the dojo sets a specific port, your agent must bind to that exact port

The port values defined in `env.ts` must match the URLs configured in `agents.ts`. If they don't line up, the dojo won't be able to find your agent.

### Step 5: Add Dojo Scripts

Add entries for your integration in the dojo script configuration at `apps/dojo/scripts/`. There are two scripts to update:

- **`prep-dojo-everything.js`** — This is the "prepare" command. It installs dependencies and builds your module (e.g., `pnpm install`, `uv sync`, `poetry install`, `go build`). It does **not** start any servers.
- **`run-dojo-everything.js`** — This is the "run" command. It starts your integration's agent server.

In both scripts, you add an entry to the `ALL_TARGETS` object. The **object key must match** the key you used in `agents.ts`. Each entry includes:
- The **name** for logging
- The **command** to execute (e.g., `uv sync` for prep, `uv run ...` for run). Use a plain `uv sync` — example apps are synced non-frozen on purpose (see Step 7's Python note).
- The **working directory** (pointing into your `integrations/` examples folder)
- **Environment variables** (optional) — for example, `PORT`

**Important rules for `run-dojo-everything.js`:**
- The **ports must not collide** with any other integration. Pick the next highest available port number.
- The `dojo` and `dojo-dev` entries in the same file need environment variables that point to your service's port, so the dojo knows where to reach your agent.
- If your integration runs **multiple agents**, you can have multiple entries in run. See `a2a-middleware` for an example of this pattern.

At this point, you should be able to spin up the dojo locally and see your integration working.

### Step 6: Add End-to-End Tests

Every feature listed in your sidebar entry (in `menu.ts`) needs a corresponding end-to-end test. **Without tests, your PR will not be considered ready.**

- **Create a test folder** for your integration inside `apps/dojo/e2e/tests/` (e.g., `apps/dojo/e2e/tests/myFrameworkTests/`). Each feature you support gets its own spec file inside this folder.
- **Follow existing test patterns** — Look at how other integrations implement their tests. If other frameworks use shared helpers from `apps/dojo/e2e/featurePages/`, you should use `featurePages` too. However, some tests use framework-specific page objects in `apps/dojo/e2e/pages/<framework-name>/`. If the same test for other frameworks lives in `pages/some-framework`, you'll need to copy it to `pages/my-framework` and adapt it for your integration.
- **Run tests locally** before submitting your PR. From `apps/dojo/`, in one terminal:
  ```bash
  ./scripts/prep-dojo-everything.js --only dojo,my-framework
  ./scripts/run-dojo-everything.js --only dojo,my-framework
  ```
  Then in a separate terminal, from `apps/dojo/e2e/`:
  ```bash
  pnpm install
  pnpm test tests/myFrameworkTests/
  ```

### Step 7: Add CI Configuration

The end-to-end tests need to run in CI as well. Update the GitHub Actions workflow file at `.github/workflows/dojo-e2e.yml`:

- **Add your integration to the test matrix** at the top of the workflow. The entry name must match the key you used in `agents.ts`. This tells CI which test path to use (e.g., `tests/myFrameworkTests`).
- **Add a services section** that defines which services to build and run. The service names map back to the `prep-dojo` and `run-dojo` scripts. The CI workflow uses a `wait-on` command to check that services are responsive (via TCP/HTTP) before running tests.

**Note:** Tests won't run by default on external PRs. The team will open a separate PR from within the repo to trigger CI, then merge the original contributor PR once tests pass.

**Python integrations:** CI pins one uv version and one CPython version for every Python job, recorded in [`.github/python-toolchain.env`](.github/python-toolchain.env). Two things follow from that, and CI enforces both.

**1. New Python CI steps must use the pin.** The `python-toolchain-pins` job fails if any workflow's literal disagrees with that file, or if a `setup-uv` invocation takes its version any other way. Declare the two values in your workflow's top-level `env:` (a workflow cannot read them from the file), then reference them:

```yaml
env:
  UV_VERSION: "0.12.1"      # must equal .github/python-toolchain.env
  PYTHON_VERSION: "3.12"

# ...
      - uses: astral-sh/setup-uv@<sha>
        with:
          version: ${{ env.UV_VERSION }}
          python-version: ${{ env.PYTHON_VERSION }}
```

A venv cache key must carry both versions, so an environment built by one toolchain is never restored into a job expecting another. Match the existing spelling:

```
py${{ env.PYTHON_VERSION }}-uv${{ env.UV_VERSION }}
```

`actions/setup-python` steps take `python-version` from the same pin. Watch the scope: `env:` is per-workflow/job/step, so a `${{ env.UV_VERSION }}` with no declaration a step can see expands to nothing and the job silently installs whatever uv is latest.

To check your work before pushing, or to find every file still to update when moving the pin:

```bash
bash scripts/release/verify-python-toolchain-pins.sh
```

It names each file and line that disagrees. Note what it does *not* verify: that the pinned versions are the right ones. That comes from a green run, which is why `python-toolchain.env` records the run its values came from — update that too when you move the pin.

**2. Lockfiles are checked, not repaired.** Python jobs install with `uv sync --locked`, the `lockfiles` job runs `uv lock --check` over every first-party `uv.lock`, and each Python job that installs dependencies ends with `.github/actions/assert-lockfiles-unchanged`, so a job that rewrites a committed lockfile fails instead of hiding the drift. If CI reports lockfile drift, run `uv lock` in the package directory and commit the result.

The one exception is the `examples/` apps: `prep-dojo-everything.js` syncs those non-frozen on purpose (it is shared with local dev, where relocking is wanted), so their lockfiles are outside both checks. That is why a plain `uv sync` is the right prep command for an example app.

### Step 8 (Optional): Update CODEOWNERS

This step is only needed if you want to be added as a co-owner who can merge changes to your integration without core team review. If this applies to you, update the `.github/CODEOWNERS` file to add yourself alongside the team:

```
integrations/my-framework @ag-ui-protocol/copilotkit @your-github-username
```

For most contributors, this is not required — the core team already owns all paths by default.

### Quick Reference Checklist

Use this checklist to verify your PR is complete before submitting:

- [ ] Integration folder added under `integrations/` with language subfolder + examples
- [ ] TypeScript client folder included (even for non-TS integrations)
- [ ] `agents.ts` updated with integration entry and feature mapping (object key is the source of truth)
- [ ] `menu.ts` updated with sidebar entry (`id` matches `agents.ts` key, `name` is human-readable)
- [ ] `env.ts` updated with agent URL environment variable
- [ ] Example code binds to `0.0.0.0` and respects `HOST`/`PORT` env vars
- [ ] `prep-dojo-everything.js` and `run-dojo-everything.js` entries added (object keys match `agents.ts`)
- [ ] Ports in `run-dojo-everything.js` do not collide with existing integrations
- [ ] `dojo`/`dojo-dev` entries updated with env vars pointing to your service's port
- [ ] End-to-end test spec files added for every supported feature
- [ ] Tests pass locally
- [ ] CI workflow matrix updated in `.github/workflows/dojo-e2e.yml` (entry name matches `agents.ts`)
- [ ] **Python only:** new CI steps use `${{ env.UV_VERSION }}` / `${{ env.PYTHON_VERSION }}` matching `.github/python-toolchain.env`, and any venv cache key carries both versions — verify with `bash scripts/release/verify-python-toolchain-pins.sh` (see Step 7)
- [ ] **Python only:** `uv.lock` committed alongside `pyproject.toml`, and `uv lock --check` passes in the package directory

---

## Contributing a Community SDK

If you're adding a new language SDK (e.g., Go, Java, Kotlin, Ruby, Rust) rather than a framework integration, place it in the `sdks/community/` folder. The team will add you as a code owner for that SDK so you can push changes without needing core team sign-off. Documentation for community SDKs also lives inside that SDK folder.

This is a separate process from adding an integration — see the steps above for framework integrations.

---

## Want to Contribute to the Docs?

Docs are part of the codebase and super valuable—thanks for helping improve them!

Here's how to contribute:

1. **Open an Issue First**
   - Open a [GitHub issue](https://github.com/ag-ui-protocol/ag-ui/issues) describing what you'd like to update or add.
   - Then comment and ask to be assigned.

2. **Submit a PR**
   - Once assigned, make your edits and open a pull request.
   - In the description, include: `Fixes #<issue-number>`
     (This links your PR to the issue and closes it automatically)

   - A maintainer will review it and merge if it looks good.

That's it! Simple and appreciated.

---

## That's It!

AG-UI is community-built, and every contribution helps shape where we go next.
Big thanks for being part of it!
