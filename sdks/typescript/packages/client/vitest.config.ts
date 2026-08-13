import path from "path";
import { mergeConfig, defineConfig } from "vitest/config";
import baseConfig from "../../vitest.base";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@/": path.resolve(__dirname, "./src") + "/",
        "@ag-ui/core/schemas": path.resolve(__dirname, "../core/src/schemas.ts"),
        "@ag-ui/core": path.resolve(__dirname, "../core/src/index.ts"),
        "@ag-ui/proto": path.resolve(__dirname, "../proto/src/index.ts"),
        "@ag-ui/encoder": path.resolve(__dirname, "../encoder/src/index.ts"),
      },
    },
  }),
);
