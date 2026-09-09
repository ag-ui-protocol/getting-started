import { expect, test } from "vitest";
import { rewriteWorkspaceDependencies } from "./workspace-deps";

const source = (dependencies: Record<string, string>) =>
  JSON.stringify({ name: "scaffold", dependencies }, null, 2) + "\n";

test("rewrites workspace: ranges to caret ranges of the published version", () => {
  const { content, updated } = rewriteWorkspaceDependencies(
    source({ "@ag-ui/adk-js": "workspace:*", react: "^19.0.0" }),
    { "@ag-ui/adk-js": "0.0.7" },
  );
  expect(updated).toEqual({ "@ag-ui/adk-js": "^0.0.7" });
  expect(JSON.parse(content).dependencies).toEqual({
    "@ag-ui/adk-js": "^0.0.7",
    react: "^19.0.0",
  });
});

test("uses the bare latest tag when no concrete version was resolved", () => {
  const { content, updated } = rewriteWorkspaceDependencies(
    source({ "@ag-ui/adk-js": "workspace:^" }),
    { "@ag-ui/adk-js": "latest" },
  );
  expect(updated).toEqual({ "@ag-ui/adk-js": "latest" });
  expect(JSON.parse(content).dependencies["@ag-ui/adk-js"]).toBe("latest");
});

test("rejects a latest fallback for a required package", () => {
  expect(() =>
    rewriteWorkspaceDependencies(
      source({ "@ag-ui/adk-js": "workspace:*" }),
      { "@ag-ui/adk-js": "latest" },
      ["@ag-ui/adk-js"],
    ),
  ).toThrow(/Could not resolve a concrete published version for @ag-ui\/adk-js/);
});

test("reports no updates when nothing uses the workspace protocol", () => {
  const { updated } = rewriteWorkspaceDependencies(source({ react: "^19.0.0" }), {
    "@ag-ui/adk-js": "0.0.7",
  });
  expect(updated).toEqual({});
});

test("throws on invalid JSON", () => {
  expect(() => rewriteWorkspaceDependencies("{not json", {})).toThrow(/not valid JSON/);
});

test("throws on a package.json that is not an object", () => {
  expect(() => rewriteWorkspaceDependencies("[]", {})).toThrow(/JSON object/);
});

test("throws when a required package is missing entirely", () => {
  expect(() =>
    rewriteWorkspaceDependencies(source({ react: "^19.0.0" }), {}, ["@ag-ui/adk-js"]),
  ).toThrow(/missing the required dependency @ag-ui\/adk-js/);
});

test("throws when a required package is still on workspace: after the rewrite", () => {
  expect(() =>
    rewriteWorkspaceDependencies(source({ "@ag-ui/adk-js": "workspace:*" }), {}, ["@ag-ui/adk-js"]),
  ).toThrow(/still on "workspace:\*"/);
});

test("accepts a required package that already has a published range", () => {
  const { updated } = rewriteWorkspaceDependencies(source({ "@ag-ui/adk-js": "^0.0.7" }), {}, [
    "@ag-ui/adk-js",
  ]);
  expect(updated).toEqual({});
});
