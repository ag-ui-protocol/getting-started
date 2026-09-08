import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // The C# server takes several seconds to start and aimock fixtures play
    // back small per-chunk delays; give individual tests enough budget for
    // the full LLM round-trip plus AG-UI streaming.
    testTimeout: 30_000,
    hookTimeout: 90_000,
    globalSetup: ["./helpers/global-setup.ts"],
    // Each getting-started/stepNN.test.ts spawns its own .NET sample server
    // and shells out to `dotnet build`. Running multiple test files in
    // parallel means concurrent builds of the shared SDK projects, which
    // contend for the same artifact lock files. Run files sequentially so
    // every Step server builds in isolation.
    fileParallelism: false,
  },
});



