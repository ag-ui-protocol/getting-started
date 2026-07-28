# @ag-ui/core CHANGELOG

## 0.1.0

### BREAKING CHANGES

- `zod` is no longer a runtime dependency of `@ag-ui/core`. The package's main entry now ships only TypeScript types, value-level constants (`EventType`) and error classes (`AGUIError`, `AGUIConnectNotImplementedError`). No `*Schema` exports and no `create*Event` factories.
- The zod schemas have moved to a new opt-in subpath: `@ag-ui/core/schemas`. zod is an optional peer dependency on the subpath, accepting `^3.25.0 || ^4.0.0` — install whichever major you prefer.
- The `create*Event` factories moved to `@ag-ui/core/schemas` as well. They validate their input through `schema.parse(...)`, which needs zod, so keeping them on the main entry would have kept the zod dependency. Consumers of `@ag-ui/client` are unaffected — it re-exports the subpath.
- The zod peer floor is `3.25.0`, not `3.24.0`. The schemas import zod's `zod/v4` subpath, which zod 3.24.x does not provide. Moving from 3.24.x to the latest 3.25.x is a patch-level upgrade within zod 3.
- The internal `BinaryInputContentSchema` runtime check moved from `superRefine` to `.refine()`. Boolean validation is unchanged; the precise error path (`["id"]`) is no longer reported.

### Behavior changes

- **Schemas now run zod's v4 engine on every supported zod version**, including zod 3.25.x, because they import `zod/v4`. Validation failures are `ZodError`s from `zod/v4`: read `error.issues` (not `error.errors`) and do not match on message strings. Accepted and rejected payloads are otherwise unchanged.
- **`z.any()` object values are now explicitly optional** in both the schemas and the hand-written types: `Tool.parameters`, `RunAgentInput.state`, `RunAgentInput.forwardedProps`, `StateSnapshotEvent.snapshot`, `RawEvent.event`, `CustomEvent.value`. A bare `z.any()` was accepted when missing on zod engine 4.0.x but rejected as `nonoptional` on 4.4.x, which made the wire contract depend on the consumer's zod version. The schemas converge on the laxer, already-shipped behavior, so nothing that validated before stops validating.
- **Event factories can no longer have their `type` discriminant overridden.** `BaseEvent`'s `[k: string]: unknown` index signature meant `Omit<Event, "type">` did not reject a caller-supplied `type`. The `EventProps<E>` helper now adds `type?: never` (a compile error), and the factories assign `type` after spreading props (safe at runtime).

### Migration

```ts
// Before
import { UserMessageSchema, createTextMessageStartEvent } from "@ag-ui/core";

// After
import { UserMessageSchema, createTextMessageStartEvent } from "@ag-ui/core/schemas";

// Unchanged — @ag-ui/client re-exports the subpath
import { UserMessageSchema, createTextMessageStartEvent } from "@ag-ui/client";
```

A jscodeshift codemod redirects both `*Schema` and `create*Event` imports:
`codemods/0.1.0-schemas-to-subpath.ts`. See
[the migration guide](https://docs.ag-ui.com/sdk/js/core/migration-0-1-0).

### Internal package changes

- `@ag-ui/client` and `@ag-ui/proto` now declare `zod` as a regular dependency and import `EventSchemas` from `@ag-ui/core/schemas` to validate incoming events. No public API change for consumers of these packages.
- `@ag-ui/client`, `@ag-ui/proto` and `@ag-ui/core` all declare the same zod range (`^3.25.0 || ^4.0.0`); they previously disagreed, which produced unmet-peer warnings.
- `@ag-ui/client`'s own legacy schemas (`src/legacy/types.ts`) also import `zod/v4`, so the package's published declarations no longer embed zod-major-specific types either.
- New `sdks/typescript/consumer-tests/run.mjs` harness plus a `zod-matrix` CI job: real tarballs are installed into a throwaway consumer for every supported zod minor and type-checked with `skipLibCheck` **disabled**, then a shared event corpus is run through `EventSchemas` to assert identical accept/reject verdicts. The matrix is resolved from the registry, so new zod releases are covered as they ship. A no-zod leg proves the main entry is dependency-free.
