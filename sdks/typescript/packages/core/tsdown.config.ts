import { defineConfig } from "tsdown";

export default defineConfig((inlineConfig) => ({
  // `schemas` is emitted from the schemas-entry barrel (schema defs + validating
  // event factories) so the output filename stays dist/schemas.* for the
  // `@ag-ui/core/schemas` export.
  entry: { index: "src/index.ts", schemas: "src/schemas-entry.ts" },
  format: ["cjs", "esm"],
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  clean: !inlineConfig.watch, // Don't clean in watch mode to prevent race conditions
}));
