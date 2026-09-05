import { describe, expect, it } from "vitest";

import { encodePackageName, packageMetadataUrl, resolveRegistry } from "./registry";

describe("resolveRegistry", () => {
  it("defaults to the public npm registry", () => {
    expect(resolveRegistry({})).toBe("https://registry.npmjs.org");
  });

  it("honors npm_config_registry as exported by npm/pnpm/yarn", () => {
    expect(resolveRegistry({ npm_config_registry: "http://localhost:4873" })).toBe(
      "http://localhost:4873",
    );
  });

  it("honors NPM_CONFIG_REGISTRY as a fallback", () => {
    expect(resolveRegistry({ NPM_CONFIG_REGISTRY: "https://mirror.example.com/npm" })).toBe(
      "https://mirror.example.com/npm",
    );
  });

  it("prefers npm_config_registry over NPM_CONFIG_REGISTRY", () => {
    expect(
      resolveRegistry({
        npm_config_registry: "http://localhost:4873",
        NPM_CONFIG_REGISTRY: "https://mirror.example.com/npm",
      }),
    ).toBe("http://localhost:4873");
  });

  it("strips trailing slashes", () => {
    expect(resolveRegistry({ npm_config_registry: "http://localhost:4873/" })).toBe(
      "http://localhost:4873",
    );
  });

  it("ignores empty or whitespace-only overrides", () => {
    expect(resolveRegistry({ npm_config_registry: "  " })).toBe("https://registry.npmjs.org");
  });
});

describe("encodePackageName", () => {
  it("keeps the @ but encodes the scope separator for scoped names", () => {
    expect(encodePackageName("@ag-ui/adk-js")).toBe("@ag-ui%2Fadk-js");
  });

  it("leaves unscoped names intact", () => {
    expect(encodePackageName("create-ag-ui-app")).toBe("create-ag-ui-app");
  });
});

describe("packageMetadataUrl", () => {
  it("builds the packument URL against the given registry", () => {
    expect(packageMetadataUrl("@ag-ui/adk-js", "http://localhost:4873")).toBe(
      "http://localhost:4873/@ag-ui%2Fadk-js",
    );
  });

  it("tolerates a trailing slash on the registry", () => {
    expect(packageMetadataUrl("@ag-ui/core", "https://registry.npmjs.org/")).toBe(
      "https://registry.npmjs.org/@ag-ui%2Fcore",
    );
  });
});
