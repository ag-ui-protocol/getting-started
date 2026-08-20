# @ag-ui/spring-ai

Implementation of the AG-UI protocol for Spring AI.

Connects Spring AI to frontend applications via the AG-UI protocol. Provides HTTP connectivity to Spring servers with support for RAG pipelines and workflow orchestration.

## Installation

```bash
npm install @ag-ui/spring-ai
pnpm add @ag-ui/spring-ai
yarn add @ag-ui/spring-ai
```

## Usage

```ts
import { SpringAiAgent } from "@ag-ui/spring-ai";

// Create an AG-UI compatible agent
const agent = new SpringAiAgent({
  url: "http://localhost:9000/agentic_chat",
  headers: { "Content-Type": "application/json" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Query my documents" }],
});
```

## Features

- **HTTP connectivity** – Connect to Spring Boot servers streaming AG-UI over SSE
- **Spring AI integration** – Drive Spring AI agents, advisors and tool callbacks
- **RAG capabilities** – Document retrieval and reasoning workflows
- **Java server support** – Pairs with the AG-UI Java server SDK

## The paired backend

Unlike most integrations in this repo, the Spring AI backend is **not vendored
here**. The Spring (WebFlux / Spring Boot starter) adapter and the Spring AI
integration ship from a separate `ag-ui-spring` repository, so that
`sdks/community/java/ag-ui/server` can stay dependency-free — see
[the Java server README](../../../../sdks/community/java/ag-ui/server/README.md).

The Dojo reaches it over HTTP at `SPRING_AI_URL` (default
`http://localhost:8080`, see `apps/dojo/src/env.ts`) and wires these lanes:
`agentic_chat`, `shared_state`, `tool_based_generative_ui`,
`human_in_the_loop`, `agentic_generative_ui`.

## Validating the protocol version ceiling

`SpringAiAgent` pins `maxVersion` to `"0.0.39"`. That value is at or below all
three backward-compat thresholds in `AbstractAgent`'s constructor, so every
shim is active on this path:

| Threshold | Effect while the ceiling stands                                                                   |
| --------- | ------------------------------------------------------------------------------------------------- |
| ≤ 0.0.39  | Flattens structured message content to text, coerces absent content to `""`, strips `parentRunId` |
| ≤ 0.0.45  | Rewrites legacy `THINKING_*` response events to `REASONING_*`                                     |
| ≤ 0.0.47  | Converts legacy `BinaryInputContent` to typed content parts                                       |

`src/__tests__/version-ceiling-baseline.test.ts` records what each of those
does on this path, without needing a backend. Every assertion in its baseline
block fails the moment the pin is removed, which is deliberate: the pin cannot
come out silently.

Removing it needs evidence from the real backend, in this order (PNI-219):

1. **Before.** With the ceiling still in place, run the adapter's unit suite
   and the Dojo lane against the real Spring AI backend. Record the result.

   ```bash
   pnpm nx run @ag-ui/spring-ai:test
   # with the backend up and SPRING_AI_URL pointing at it:
   cd apps/dojo/e2e && BASE_URL=http://localhost:9999 pnpm test -- tests/springAiTests
   ```

2. **Check the three risk axes** the shims currently paper over. None of them
   are exercised by the `agentic_chat` lane — it sends plain-string content,
   which reads identically with and without the ceiling — so a green chat run
   is _not_ evidence for removing the pin:
   - Does the backend accept structured (multimodal) `content` arrays, or does
     it require a flattened string?
   - Does it tolerate an assistant message whose `content` is absent rather
     than `""`?
   - Does it emit `REASONING_*` natively, or still legacy `THINKING_*`?

3. **Fix only what 1.0 actually broke.** Anything else is a separate ticket.

4. **Remove the ceiling** — delete the `maxVersion` getter outright; do not
   rename it. Invert the baseline test block in the same commit so it asserts
   pass-through instead of flattening.

5. **After.** Re-run the identical adapter, backend and Dojo matrix from step 1
   so the two runs are comparable.

> The `springAiTests` suite is intentionally absent from the `dojo-e2e` CI
> matrix: that workflow starts each backend from this repo, and Spring AI's
> cannot be. Run it manually against a backend you host.
