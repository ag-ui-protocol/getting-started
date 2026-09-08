import path from "path";
import { defineConfig } from "vitest/config";

/**
 * The examples own their tests.
 *
 * These files used to be collected by the parent package's config. That put
 * them in one project's test run while Nx attributed the files themselves to
 * this one, so editing an example never invalidated the run that executed it
 * and `nx run ... :test` replayed a stale pass. Running them from here keys the
 * cache on the files under test.
 */

/** Make a path safe to use as a `String.replace` replacement. */
function escapeReplacement(value: string): string {
  return value.replace(/\$/g, "$$$$");
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/**/*.test.ts"],
    passWithNoTests: false,
  },
  resolve: {
    alias: [
      // The demos import the adapter the way a consumer does, by name, which
      // resolves through `exports` to `dist/`. Pointing those two specifiers at
      // the source means a change to the adapter is picked up without
      // rebuilding it. The other workspace packages it pulls in still resolve
      // through their own `exports`, which is why this project's `test` target
      // declares a build dependency. The published entry points stay covered by
      // the parent package's `test:exports`.
      //
      // Anchored rather than bare strings: Vite matches a string alias as a
      // prefix, so a bare `@ag-ui/aws-strands` would also rewrite every
      // subpath, and which of the two won would depend on key order.
      {
        find: /^@ag-ui\/aws-strands$/,
        // Escaped: the replacement of a regex alias goes through
        // `String.replace`, where a `$` in the checkout path would read as a
        // backreference.
        replacement: escapeReplacement(
          path.resolve(__dirname, "../src/index.ts"),
        ),
      },
      {
        find: /^@ag-ui\/aws-strands\/server$/,
        replacement: escapeReplacement(
          path.resolve(__dirname, "../src/server.ts"),
        ),
      },
    ],
  },
});
