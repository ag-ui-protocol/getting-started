# Packaged-consumer compatibility tests

`@ag-ui/core/schemas` supports zod `^3.25.0 || ^4.0.0`. The workspace pins a single
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

# Full matrix: newest patch of every supported zod minor, plus the no-zod leg
node sdks/typescript/consumer-tests/run.mjs

# A single leg
node sdks/typescript/consumer-tests/run.mjs 4.4.3
node sdks/typescript/consumer-tests/run.mjs none

# Print the resolved matrix without running anything
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

## The matrix is not hardcoded

`--list` queries the npm registry and reduces every version in `^3.25.0 || ^4.0.0`
to the newest patch of each minor line. zod releases that do not exist yet (4.5,
4.6, ...) are therefore covered the day they ship, rather than whenever someone
remembers to extend a list. The `zod-matrix` job in
`.github/workflows/unit-typescript-sdk.yml` resolves the same list into a GitHub
Actions matrix, so each version is a separately reported leg.

## Adding cases

Add payloads to `packages/core/src/__tests__/fixtures/event-corpus.ts`. That file
is deliberately import-free so it can be consumed both by vitest
(`zod-version-conformance.test.ts`, against the workspace zod) and by this harness
(against an arbitrary zod). Every entry must produce the same verdict on every
supported version — if a zod release changes one, this job goes red instead of the
protocol silently changing under consumers.
