import { mergeConfig } from "vitest/config";
import baseConfig from "../sdks/typescript/vitest.base";

export default mergeConfig(baseConfig, {
  test: {
    // The shared base sets passWithNoTests, which is right for a package that may
    // legitimately have none. Here it would mean a broken discovery glob or a
    // renamed harness file exits 0 with nothing checked at all, and CI merging on
    // the strength of it.
    passWithNoTests: false,
  },
});
