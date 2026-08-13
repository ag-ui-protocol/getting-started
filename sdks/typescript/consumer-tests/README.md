# Packaged-consumer compatibility tests

`@ag-ui/core/schemas` supports zod `^3.25.18 || ^4.0.0`. The workspace pins a single
zod version (`pnpm.overrides.zod` in the root `package.json`), so the in-repo test
suites can only ever exercise that one — they cannot prove the _published_ package
works on the rest of the range. This harness closes that gap.

It builds real tarballs with `pnpm pack` (so `workspace:*` deps are rewritten to
concrete versions), installs them into a throwaway project alongside one specific
zod version, and runs three gates:

| Gate            | What it proves                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **typecheck**   | `tsc --noEmit`, strict, `moduleResolution: NodeNext`, **`skipLibCheck: false`** over files importing `@ag-ui/core/schemas` and `@ag-ui/client`. Catches zod-major-specific declaration shapes leaking into the published `.d.ts` — the failure mode that produced ~960 library errors for zod 4 consumers before the `zod/v4` switch.                                                                                   |
| **conformance** | Runs the shared corpus at `packages/core/src/__tests__/fixtures/event-corpus.ts` through `EventSchemas` and asserts the accept/reject verdict _and_ post-parse normalization. The zod/v4 **engine** version differs across the range (zod@3.25.x ships engine 4.0.0, zod@4.4.x ships 4.4.x) and engine releases have changed parse behavior, so this is what keeps the wire contract independent of the consumer's zod. |
| **no-zod**      | Imports `@ag-ui/core` with zod absent entirely, proving the main entry really is dependency-free.                                                                                                                                                                                                                                                                                                                       |

## Usage

```bash
# Build the packages first — the harness packs whatever is in dist/
pnpm --filter "@ag-ui/core" --filter "@ag-ui/encoder" \
     --filter "@ag-ui/proto" --filter "@ag-ui/client" run build

# The default legs (3.25.18, 4.0.0, 4.4.3, none)
node sdks/typescript/consumer-tests/run.mjs

# A single leg
node sdks/typescript/consumer-tests/run.mjs 4.4.3
node sdks/typescript/consumer-tests/run.mjs none

# Print the default legs without running anything
node sdks/typescript/consumer-tests/run.mjs --list
```

Expected output per leg:

```
=== zod 4.4.3 ===
  zod 4.4.3, zod/v4 engine {"major":4,"minor":4,"patch":3}
  typecheck ok (strict, NodeNext, skipLibCheck:false)
  corpus: 48 accept + 15 reject
  conformance ok
```

## The version list

`DEFAULT_LEGS` in `run.mjs` and the `zod-matrix` matrix in
`.github/workflows/unit-typescript-sdk.yml` hold the same short, hand-maintained
list. Keep them in sync.

| Leg | Why |
|---|---|
| `3.25.18` | The advertised floor, established by bisection. zod 3.24.x has no `zod/v4` subpath; 3.25.0 is a broken publish shipping only `src/`; 3.25.1-3.25.17 ship `zod/v4` declarations that fail TS variance checks (4x TS2636 inside zod's own `.d.ts`) under `skipLibCheck: false`. 3.25.18 is the first clean release. |
| `4.0.0` | The zod 4 floor. |
| `4.4.3` | Latest zod 4 at time of writing. |
| `none` | No zod installed. |

Deliberately explicit rather than resolved from the registry: a CI job that
silently changes shape when a dependency publishes is worse than one that needs a
one-line edit. Add entries when there is a reason to. Spot-checking a release
that is not on the list needs no code change at all:

```bash
node sdks/typescript/consumer-tests/run.mjs 4.5.0
```

## Adding cases

Add payloads to `packages/core/src/__tests__/fixtures/event-corpus.ts`. That file
is deliberately import-free so it can be consumed both by vitest
(`zod-version-conformance.test.ts`, against the workspace zod) and by this harness
(against an arbitrary zod). Every entry must produce the same verdict on every
supported version — if a zod release changes one, this job goes red instead of the
protocol silently changing under consumers.
