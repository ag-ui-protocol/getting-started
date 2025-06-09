import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: !options.watch, // Don't clean in watch mode to prevent race conditions
  minify: !options.watch, // Don't minify in watch mode for faster builds
}));
