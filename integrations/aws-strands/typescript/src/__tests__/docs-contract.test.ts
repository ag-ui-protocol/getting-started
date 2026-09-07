/**
 * The README's load-bearing claims, checked against the code.
 *
 * Review of this package repeatedly found documentation that named a constant
 * the adapter does not emit, or a shape it does not produce. Prose drifts
 * because nothing reads it. These assertions read it, so the mechanically
 * checkable claims cannot drift silently again.
 *
 * Deliberately narrow. A test can check that a named error code exists and that
 * a documented shape is the shape produced; it cannot check whether a sentence
 * is complete or whether a rationale still holds. Those stay with human review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as pkg from "../index";
import { INTERRUPT_CANCELLED } from "../index";
import {
  collect,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  recordingTool,
} from "./helpers";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";

const root = join(__dirname, "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const source = readFileSync(join(root, "src", "agent.ts"), "utf8");

describe("README claims that the code has to back", () => {
  it("names only error codes the adapter actually emits", () => {
    // e.g. `RUN_ERROR { code: "UNKNOWN_INTERRUPT_ID" }`
    const named = [...readme.matchAll(/code:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(
      named.length,
      "no error code found in the README to check",
    ).toBeGreaterThan(0);

    // Searched with the comments stripped out. A mention in prose is exactly
    // what would survive a rename on the wire, and this file rejects the same
    // technique below.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const missing = [...new Set(named)].filter(
      (named) => !code.includes(`"${named}"`),
    );
    expect(
      missing,
      "the README names error codes the adapter never emits",
    ).toEqual([]);
  });

  it("documents the resume contract with the shapes the adapter produces", () => {
    // The three rows of the resume-contract table, as the adapter builds them.
    for (const shape of [
      "{ response: payload }",
      "{ response: null }",
      "{ cancelled: true }",
    ]) {
      expect(
        readme.includes(shape),
        `the resume-contract table no longer documents ${shape}`,
      ).toBe(true);
    }
  });

  it("documents the cancellation sentinel as the value it exports", () => {
    expect(INTERRUPT_CANCELLED).toEqual({ cancelled: true });
    expect(
      readme.includes("`{ cancelled: true }`"),
      "the README no longer states the cancellation shape it exports",
    ).toBe(true);
  });

  it("documents the reserved interrupt-name prefix the code reserves", () => {
    const prefix = "ag_ui:tool_call:";
    expect(source.includes(`"${prefix}"`)).toBe(true);
    expect(
      readme.includes(prefix),
      "the reserved name prefix is undocumented",
    ).toBe(true);
  });

  it("documents every approval metadata key the adapter publishes", async () => {
    // Derived from a published interrupt, not from a list kept beside this test
    // and not from a search of the source text. A text search is satisfied by
    // the comments that discuss these keys, so renaming one on the wire left
    // this assertion green.
    const { tool: gated } = recordingTool("confirm_delete");
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-1",
          name: "confirm_delete",
          input: {},
        }),
        modelTurn.text("done"),
      ],
      {
        tools: [gated],
        config: {
          toolBehaviors: { confirm_delete: { interruptOnCall: true } },
        },
      },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as
      | (BaseEvent & {
          outcome?: { interrupts?: { metadata?: Record<string, unknown> }[] };
        })
      | undefined;
    const published = Object.keys(
      finished?.outcome?.interrupts?.[0]?.metadata ?? {},
    );
    expect(
      published.length,
      "no approval metadata keys found to check",
    ).toBeGreaterThan(0);

    // Scoped to the passage that documents these keys, and matched as a code
    // span. A search of the whole README passes on any token that happens to
    // appear anywhere in it, which is how a rename to a word the prose already
    // uses would go unnoticed.
    const anchor = readme.indexOf("always carries");
    expect(
      anchor,
      "the approval-metadata passage moved or was renamed",
    ).not.toBe(-1);
    const passage = readme.slice(anchor, readme.indexOf("\n\n", anchor));
    const undocumented = published.filter(
      (key) => !passage.includes(`\`${key}\``),
    );
    expect(
      undocumented,
      `the README does not document published approval metadata keys: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("documents the conditional key an unusable reason publishes", async () => {
    // A well-formed approval carries only the unconditional keys, so the case
    // above never reaches the one the README documents as conditional. This
    // reaches it: a reserved-prefix interrupt raised by a tool with a reason
    // the mapper cannot read publishes that reason alongside the defaults.
    const odd = tool({
      name: "odd",
      description:
        "Raises an approval-named interrupt with a non-object reason",
      inputSchema: z.object({}).passthrough(),
      callback: async (_input: unknown, context?: ToolContext) => {
        context!.interrupt({
          name: "ag_ui:tool_call:odd",
          reason: "not a mapping",
        });
        return { ok: true };
      },
    });
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-1", name: "odd", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [odd] },
    );
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "go" } as never],
      }),
    );
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as
      | (BaseEvent & {
          outcome?: { interrupts?: { metadata?: Record<string, unknown> }[] };
        })
      | undefined;
    const published = Object.keys(
      finished?.outcome?.interrupts?.[0]?.metadata ?? {},
    );
    expect(
      published,
      "the unusable reason was not published, so this checks nothing",
    ).toContain("reason");

    const anchor = readme.indexOf("always carries");
    const passage = readme.slice(anchor, readme.indexOf("\n\n", anchor));
    const undocumented = published.filter(
      (key) => !passage.includes(`\`${key}\``),
    );
    expect(
      undocumented,
      `the README does not document published approval metadata keys: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("imports only names the package entry actually exports", () => {
    // The URL fetch policy section is written as code a reader will paste, and
    // its whole point is that the override is spelled by spreading the
    // exported default. A renamed export would leave a snippet that does not
    // compile, which prose review does not catch.
    const imports = [
      ...readme.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"@ag-ui\/aws-strands"/g,
      ),
    ].flatMap((match) =>
      match[1]!
        .split(",")
        .map((name) => name.trim().replace(/^type\s+/, ""))
        .filter((name) => name.length > 0),
    );
    expect(imports, "no package import found in the README to check").toContain(
      "DEFAULT_URL_FETCH_POLICY",
    );

    // Checked against the entry's SOURCE, not only against the module object:
    // a type export is erased at runtime, and README snippets import types
    // without always marking them `type`. The one value the section's whole
    // idiom rests on is checked at runtime as well.
    // Comments stripped: this file's export block explains itself by naming
    // the neighbours it deliberately leaves out, and a mention there is not
    // an export.
    const entry = readFileSync(join(root, "src", "index.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const missing = [...new Set(imports)].filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(entry),
    );
    expect(
      missing,
      "the README imports names the package entry does not export",
    ).toEqual([]);
    expect(pkg.DEFAULT_URL_FETCH_POLICY).toBeDefined();
  });

  it("documents the URL fetch defaults the code actually applies", () => {
    const anchor = readme.indexOf("## Fetching URL content sources");
    expect(
      anchor,
      "the README no longer documents URL fetching",
    ).toBeGreaterThan(-1);
    const section = readme.slice(anchor, readme.indexOf("\n## ", anchor + 1));

    // Only the two claims a test can settle: which schemes the default
    // fetches, and that the private network is off until a host turns it on.
    for (const scheme of pkg.DEFAULT_URL_FETCH_POLICY.allowedSchemes) {
      expect(
        section.includes(scheme),
        `the section does not name the '${scheme}' scheme the default allows`,
      ).toBe(true);
    }
    expect(pkg.DEFAULT_URL_FETCH_POLICY.allowPrivateNetworks).toBe(false);
    expect(section).toContain("allowPrivateNetworks");
  });
});
