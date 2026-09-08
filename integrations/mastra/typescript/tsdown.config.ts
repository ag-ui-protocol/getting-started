import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    copilotkit: "src/copilotkit.ts",
    // Bridge-free entry: server-side / remote agents import getA2UITools +
    // planA2UIInjection from "@ag-ui/mastra/a2ui" WITHOUT pulling the
    // AbstractAgent bridge (and its @ag-ui/client → uuid runtime dep), which the
    // Mastra CLI bundler can't resolve.
    a2ui: "src/a2ui-tool.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  exports: true,
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  minify: true,
});
