import { defineConfig } from "tsdown";

export default defineConfig((inlineConfig) => ({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  clean: !inlineConfig.watch,
}));
