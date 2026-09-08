# AG-UI Protocol Dojo

A modern, interactive viewer for exploring CopilotKit agent demos with a clean, responsive UI and dark/light theme support.

## Overview

The Demo Viewer provides a centralized interface for browsing, viewing, and exploring the source code of various CopilotKit agent demos. It features:

- Clean, modern UI with dark/light theme support
- Interactive demo previews
- Source code exploration with syntax highlighting
- Organized demo listing with tags and descriptions
- LLM provider selection

## Development Setup

To run the Demo Viewer locally for development, follow these steps:

### Install dependencies

```bash
brew install protobuf
```

Note that running the dojo currently requires the use of `pnpm` (vs `yarn` or `npm`) do to how we handle  workspace dependencies.
```bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

The first time you want to run, you need to build all of the dojos dependencies throught the repository.
```
# from the ag-ui repository root
pnpm i
pnpm build --projects=demo-viewer
```

### Run the Demo Viewer

There are 3 ways to run the demo viewer

- Run just the demo viewer, and run the agent(s) separately
- Run the dev script for the entire repo, and run the agent(s) separately
- use the `dojo-everything` scripts

#### Run just the demo viewer, and run the agent(s) separately.

In one terminal, you can `cd` into the dojo directory and run `pnpm dev` to just run the dojo
This will not capture updates to dependencies of the dojo
In another terminal, you'll need to run any other agents you want to test separately, see "Run Agents" below.
The dojo will start on port 3000 by default

Note that some agents may run on colliding ports

#### Run the dev script for the entire repo, and run the agent(s) separately
In one terminal, you can run `pnpm dev` from the *repository root*
This WILL automatically rebuild dependencies, for example if you change the mastra integration, it will automatically rebuild and be bundled into the dojo with HMR.
In another terminal, you'll need to run any other agents you want to test separately, see "Run Agents" below.
The dojo will start on port 3000 by default

Note that some agents may run on colliding ports

#### Run Agents
Agent examples for the dojo are generally located in `integrations/{integrationName}/{language}/examples`. A readme there should explain what you need to do to run the example, but it's usually either `npm dev` for typescript packages, or `poetry install && poetry run dev` or `uv sync && uv run dev` for python servers.

Note that some agents may run on colliding ports

#### Use the `dojo-everything` scripts

These are the easiest ways to run everything. They will automatically configure all of your ports to not be colliding, provide that information to the dojo, and spin up the dojo.

```
# In the apps/dojo directory
./scripts/prep-dojo-everything.js
./scripts/run-dojo-everything.js
```

The demo viewer will now run on port 9999.

The one caveat here is that (for precompiled speed while running tests) this runs a production nextjs build, and that build has to be redone if you modify the dojo code at all (or any of the typescript integrations).

You can look in the `run-dojo-everything.js` script and see which ports it runs agents at, and export those as environment variables, which can be found in `apps/dojo/src/env.ts`. Then you can run the dojo via `pnpm dev` at the repo root, to get live updates to typescript integrations and the dojo. There is not HMR on most of the python framework agent examples.

To choose which agents or services the `run-dojo-everything.js` script runs you can use the `--only` flag, like this: `./scripts/run-dojo-everything.js --only adk-middleware,langgraph-fastapi`. The names for these IDs match what is in `src/agents.ts` as well as being findable in the run-dojo-everything script. .

### Adding a new integration
Integrations should go in `integrations/{integrationID}`. There should always be a typescript folder that at least contains the client, and possibly a python (or other language) folder.

To add it to the dojo, please make sure it gets added to
- src/agents.ts
- src/menu.ts
- scripts/prep-dojo-everything.js
- scripts/run-dojo-everything.js
- e2e.yml
- the `apps/dojo/e2e` folder, look in the tests folder of other frameworks, and you should be able to mostly dupiclate these.
