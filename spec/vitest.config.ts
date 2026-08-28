import { mergeConfig } from "vitest/config";
import baseConfig from "../sdks/typescript/vitest.base";

export default mergeConfig(baseConfig, {
  test: {
    // The shared base sets passWithNoTests, which is right for a package that may
    // legitimately have none. Here it would mean a broken discovery glob or a
    // renamed harness file exits 0 with nothing checked at all, and CI merging on
    // the strength of it.
    passWithNoTests: false,
    // Three tests here — the determinism check, the schema compile, and the
    // published-copy comparison — each run the generator or compile every
    // definition, and each is the FIRST test in its file to touch that module
    // graph, so it also pays the cold import. Locally that is 70-130ms; on a
    // loaded CI runner it measured 4.6-5.5s and tripped vitest's 5s default,
    // failing the suite on timing rather than on anything it checks. The work
    // is genuinely long-running, which is the case the option exists for.
    testTimeout: 30_000,
  },
});
