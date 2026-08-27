import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_SPEC_OUTPUT_DIR, SCHEMA_PATH } from "../generator/generate";

/**
 * The published address is part of the contract, not a deployment detail.
 *
 * Every schema file names its own web address in `$id`, and a tool that meets
 * one fetches that address to resolve it. The address therefore has to serve
 * the file, and the shape chosen for the draft is the shape every frozen
 * version inherits — those are permanent, so a mistake here is expensive.
 *
 * What this file can check is what this repository controls: that the file is
 * published, that it is the schema rather than a stale copy of it, that its
 * `$id` agrees with the address it is served at, and that no documentation
 * page is named so that it would shadow it. The routing and the CORS header
 * live in Cloudflare, which no test here can see; docs/spec/README.md records
 * that configuration, who owns it, and how to verify it by hand.
 */
const PUBLISHED_ORIGIN = "https://ag-ui.com";
const PUBLISHED_PREFIX = "/spec/draft";

describe("the published draft schema", () => {
  const publishedPath = join(DOCS_SPEC_OUTPUT_DIR, "schema.json");

  it("is published where the docs site serves it", () => {
    expect(
      existsSync(publishedPath),
      `${publishedPath} is missing — run: pnpm --filter @ag-ui/spec generate`,
    ).toBe(true);
  });

  it("is byte-for-byte the schema the SDKs are generated from", () => {
    // Not "equivalent JSON": the same bytes. A re-serialisation would still
    // parse, but consumers pin and diff this file, and a formatting change
    // nobody made would read as a protocol change.
    expect(readFileSync(publishedPath)).toEqual(readFileSync(SCHEMA_PATH));
  });

  it("states the address it is served at", () => {
    const schema = JSON.parse(readFileSync(publishedPath, "utf8")) as {
      $id?: string;
    };
    expect(schema.$id).toBe(
      `${PUBLISHED_ORIGIN}${PUBLISHED_PREFIX}/schema.json`,
    );
  });

  it("keeps every published file's address free for the docs pages beside it", () => {
    // One folder holds both the readable pages and the machine-readable files,
    // so /spec/draft/schema.json is a file while /spec/draft/lifecycle is a
    // page. Two things must not claim one address: which of them the renderer
    // would serve is its business rather than something the protocol should
    // depend on.
    //
    // Compare ADDRESSES, not file names. A page's address is its name without
    // the .mdx suffix, so `schema.json.mdx` claims /spec/draft/schema.json and
    // collides, while `schema.mdx` claims /spec/draft/schema and does not.
    // Comparing stems would get both of those backwards.
    const entries = readdirSync(DOCS_SPEC_OUTPUT_DIR);
    const pageAddresses = new Set(
      entries
        .filter((entry) => extname(entry) === ".mdx")
        .map((entry) => entry.slice(0, -".mdx".length)),
    );
    const collisions = entries
      .filter((entry) => extname(entry) === ".json")
      .filter((entry) => pageAddresses.has(entry));
    expect(collisions).toEqual([]);
  });
});
