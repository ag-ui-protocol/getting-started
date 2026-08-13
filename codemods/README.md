# @ag-ui/core codemods

Automated transforms for upgrading code that depends on `@ag-ui/core`.

---

## 0.1.0-schemas-to-subpath

**What it does.** Moves the exports that left the main `@ag-ui/core` entry in 0.1.0 to the new `@ag-ui/core/schemas` subpath:

- every `*Schema` import (and `EventSchemas`, the only "Schemas" plural export)
- every `create*Event` factory — these validate through `schema.parse(...)`, so they moved to the subpath with the schemas to keep the main entry dependency-free

If a file already has an import from `@ag-ui/core/schemas`, the moved specifiers are merged into it rather than creating a duplicate declaration. Type-only imports (`import type { ... }`) are preserved on the appropriate side. The transform is idempotent — running it twice produces the same output.

Imports from `@ag-ui/client` need no migration and are left alone — that package re-exports the subpath.

**How to run it.**

```bash
npx jscodeshift -t https://raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/codemods/0.1.0-schemas-to-subpath.ts \
  --parser=tsx \
  --extensions=ts,tsx \
  src/
```

To do a dry run (print changes without writing):

```bash
npx jscodeshift --dry --print \
  -t https://raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/codemods/0.1.0-schemas-to-subpath.ts \
  --parser=tsx \
  --extensions=ts,tsx \
  src/
```

**What it does NOT do.**

- It does not add `zod` to your `package.json`. After running the codemod, run `npm install zod` (or `pnpm add zod` / `yarn add zod`) if any file imports from `@ag-ui/core/schemas`.
- It does not update the `@ag-ui/core` version constraint in `package.json`. Update it to `^0.1.0` manually.

**Recognized schema names.**

The transform uses two complementary heuristics:

1. Any imported name that ends with `"Schema"` is moved (e.g. `UserMessageSchema`, `AgentCapabilitiesSchema`).
2. The name `EventSchemas` is explicitly matched (the only "Schemas" plural export).
3. Any imported name matching `create<Something>Event` is moved (e.g. `createTextMessageStartEvent`, `createRunFinishedInterruptEvent`). Matched by shape rather than a curated list; since the transform only rewrites specifiers that were already imported from `@ag-ui/core`, an unrelated local `createFooEvent` is unaffected.

The curated list in `SCHEMA_NAMES` inside the transform source mirrors the full public schema surface of `@ag-ui/core/schemas`. Both heuristics are applied, so unknown future schema additions (if they follow the naming convention) are also covered.

**Aliasing behavior.**

**Aliased imports work correctly.** Detection uses the *imported* name (the name on the `@ag-ui/core` side), so `import { UserMessageSchema as Foo } from "@ag-ui/core"` is recognized regardless of the local alias. The alias is preserved in the moved declaration: `import { UserMessageSchema as Foo } from "@ag-ui/core/schemas"`.

**Known limitations.**

- **Namespace imports** — `import * as core from "@ag-ui/core"` cannot be automatically migrated. The codemod will emit a warning to stderr and leave the import untouched. You must manually split `core.<SchemaName>` references into a named import from `@ag-ui/core/schemas` and update all usages.
- **Re-exports** — `export { UserMessageSchema } from "@ag-ui/core"` is not handled; only `import` declarations are transformed. Re-export-from syntax will need to be updated manually.
- **Dynamic imports** — `import("@ag-ui/core")` and `require("@ag-ui/core")` calls are not transformed; only static `import` declarations are handled.

---

For more context, see the [0.1.0 migration guide](https://docs.ag-ui.com/sdk/js/core/migration-0-1-0).
