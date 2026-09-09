import { defineConfig } from "tsdown";

export default defineConfig((inlineConfig) => ({
  entry: ["src/index.ts", "src/schemas.ts"],
  format: ["cjs", "esm"],
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  clean: !inlineConfig.watch, // Don't clean in watch mode to prevent race conditions
}));
