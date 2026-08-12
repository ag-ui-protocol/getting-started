# Thread-wide AG-UI Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `compactEvents` preserve cumulative agent state across run boundaries and document its real behavior.

**Architecture:** Keep one state accumulator for the full ordered input and emit a cumulative snapshot at each existing state flush boundary. Preserve the current event-stream API, text/tool folding, and exception behavior for invalid JSON Patch operations.

**Tech Stack:** TypeScript, Vitest, `fast-json-patch`, Nx, MDX.

---

### Task 1: Prove cross-run state semantics

**Files:**
- Modify: `sdks/typescript/packages/client/src/compact/__tests__/compact.test.ts`

- [ ] Add fixtures where run 1 snapshots state and run 2 has only `add`, `replace`, and `remove` deltas.
- [ ] Assert every emitted state boundary contains the cumulative thread state.
- [ ] Add an invalid cross-run delta case and assert `compactEvents` throws.
- [ ] Run `pnpm nx test client -- --runInBand` and confirm the new cumulative assertion fails because run 2 resets to `{}`.

### Task 2: Carry state across run boundaries

**Files:**
- Modify: `sdks/typescript/packages/client/src/compact/compact.ts`

- [ ] Replace run-local state initialization with one thread-wide accumulator.
- [ ] Flush a cloned cumulative snapshot without clearing the accumulator.
- [ ] Keep JSON Patch validation and non-mutating application semantics.
- [ ] Run `pnpm nx test client`, `pnpm nx run client:typecheck`, and `pnpm nx run client:lint`.

### Task 3: Correct public docs

**Files:**
- Modify: `docs/sdk/js/client/compaction.mdx`
- Modify: `docs/concepts/serialization.mdx`

- [ ] State that `RAW` events are not removed by the generic helper unless the API explicitly gains that behavior.
- [ ] Explain text/tool folding and cumulative state snapshots across runs.
- [ ] Document that invalid deltas throw and callers may treat that as a compact-candidate failure.
- [ ] Run the repository docs checks that cover these pages.
