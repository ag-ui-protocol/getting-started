# AWS Strands TypeScript Examples

Fifteen runnable AG-UI demos built on `@strands-agents/sdk`. Each file under
`server/api/` is the single definition of its demo: it builds the thing the demo
drives, wraps it in a `StrandsAgent`, and exports that as a factory.
`server/server.ts` is a "dojo" that calls every factory and mounts them all on
one port, at the same paths the Python reference server uses, so both
implementations answer the same payloads.

## How to run

Build the adapter these demos import, then install here:

```bash
# from the repo root
pnpm install
pnpm --filter @ag-ui/aws-strands build
```

Create a `.env` beside `package.json` with a key for your provider. Every demo
script passes `--env-file-if-exists=.env`, a Node 20.12+ flag, so no `dotenv`
call is involved:

```bash
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-key
```

Every demo at once, on `http://localhost:8022`:

```bash
cd integrations/aws-strands/typescript/examples
pnpm dojo
```

Or one demo on its own, on `http://localhost:8000`:

```bash
pnpm agentic-chat
```

`PORT` overrides either port and `HOST` the bind address, which defaults to
`0.0.0.0`. `pnpm test` runs the vitest suite beside the demos and
`pnpm typecheck` type-checks without emitting.

## Available agents

Ten demos have a `pnpm run <demo>` script. Eleven carry a standalone runner,
guarded so importing the file starts no server: `agentic-chat-citations.ts` is
the eleventh, with no script pointing at it, so run it with `pnpm tsx
--env-file-if-exists=.env server/api/agentic-chat-citations.ts`. The multi-agent
and three a2ui files export their factory only and are reached through the dojo.
Read the file for what a demo does; the demo is the documentation.

| File                            | Dojo route                  | On its own       |
| ------------------------------- | --------------------------- | ---------------- |
| `agentic-chat.ts`               | `/agentic-chat`             | `pnpm` script    |
| `agentic-chat-reasoning.ts`     | `/agentic-chat-reasoning`   | `pnpm` script    |
| `agentic-chat-citations.ts`     | `/agentic-chat-citations`   | `tsx` directly   |
| `agentic-chat-multimodal.ts`    | `/agentic-chat-multimodal`  | `pnpm` script    |
| `backend-tool-rendering.ts`     | `/backend-tool-rendering`   | `pnpm` script    |
| `shared-state.ts`               | `/shared-state`             | `pnpm` script    |
| `agentic-generative-ui.ts`      | `/agentic-generative-ui`    | `pnpm` script    |
| `human-in-the-loop.ts`          | `/human-in-the-loop`        | `pnpm` script    |
| `interrupt.ts`                  | `/interrupt`                | `pnpm` script    |
| `predictive-state-updates.ts`   | `/predictive-state-updates` | `pnpm` script    |
| `tool-based-generative-ui.ts`   | `/tool-based-generative-ui` | `pnpm` script    |
| `multi-agent.ts`                | `/multi-agent`              | dojo only        |
| `a2ui-dynamic-schema.ts`        | `/a2ui-dynamic-schema`      | dojo only        |
| `a2ui-fixed-schema.ts`          | `/a2ui-fixed-schema`        | dojo only        |
| `a2ui-recovery.ts`              | `/a2ui-recovery`            | dojo only        |

The dojo also serves `GET /ping` and `GET /capabilities`.

## Project structure

```
integrations/aws-strands/typescript/examples
├── server/
│   ├── api/                      # one factory per demo, the files above
│   ├── __fixtures__/             # entry points run-if-main.test.ts spawns
│   ├── server.ts                 # the dojo: mounts every demo
│   ├── model-factory.ts          # MODEL_PROVIDER / MODEL_ID -> a Strands model
│   ├── cors.ts                   # CORS_ALLOW_ORIGINS -> a cors policy
│   ├── run-if-main.ts            # PORT / HOST, the import guard, listen-or-exit
│   ├── fixtures.ts               # typed stand-ins for the adapter's hook args
│   ├── demo-agents.test.ts       # the contracts the dojo pages depend on
│   ├── run-if-main.test.ts
│   ├── model-factory.test.ts
│   └── model-factory-packages.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Environment variables

| Variable             | Purpose                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `MODEL_PROVIDER`     | `openai` (default), `anthropic`, `gemini` or `bedrock`; anything else is refused by name    |
| `MODEL_ID`           | Override the provider's default model                                                       |
| `OPENAI_API_KEY`     | Required on `openai`                                                                        |
| `ANTHROPIC_API_KEY`  | Required on `anthropic`                                                                     |
| `GOOGLE_API_KEY`     | Required on `gemini`                                                                        |
| `OPENAI_BASE_URL`    | Point the OpenAI client somewhere else                                                      |
| `PORT`               | Listen port. Blank is unset; anything not an integer in 1 to 65535 is refused with the value |
| `HOST`               | Bind address, default `0.0.0.0`                                                             |
| `CORS_ALLOW_ORIGINS` | Comma-separated origins, default `http://localhost:9999,http://localhost:3000`. Set but naming none allows nothing rather than widening |

`bedrock` takes no key here and uses your ambient AWS credentials. The provider
defaults are in `server/model-factory.ts`.

## Dependencies

`@strands-agents/sdk` builds the agents and `@ag-ui/aws-strands` wraps them, as
a workspace dependency, which is why it has to be built first. `express` and
`cors` serve them, `zod` types the tools, and `a2ui-fixed-schema.ts` reaches for
`@ag-ui/a2ui-toolkit`. The `openai`, `@anthropic-ai/sdk` and `@google/genai`
clients are what the Strands model providers load. `tsx` runs the demos and
`vitest` tests them. `package.json` holds the ranges and the rest.
