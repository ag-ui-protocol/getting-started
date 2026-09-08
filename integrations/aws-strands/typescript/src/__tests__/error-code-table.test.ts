/**
 * The cross-runtime parity check for the shared error-code table.
 *
 * Modelled on `integrations/langgraph/cross-runtime-parity-cases.json`: one
 * table, read by both runtimes' suites, so a contract that has to hold on both
 * sides lives in one file rather than in two hand-mirrored lists. The Python
 * half of this check is `tests/test_error_code_table.py`, and it makes the same
 * assertions over the same data.
 *
 * What is checked here is the SHAPE of the contract, not either source. A code
 * listed on both sides carries one copy of its text, so the terminal-path
 * suites on the two sides are matched against the same string; a code listed on
 * one side has to say why. The last test is a literal-string backstop, and only
 * in the direction the table can support: a code named here must still appear
 * in this bridge's source. Nothing reads that source as code.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CODES, SIDE, TABLE, matchesTemplate } from "./error-code-table";

const SIDES = new Set(["python", "typescript"]);

const SRC_DIR = path.resolve(__dirname, "..");
const SOURCES = readdirSync(SRC_DIR)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => readFileSync(path.join(SRC_DIR, name), "utf8"));

const codes = [...CODES.keys()].sort();

describe("cross-runtime error-code table", () => {
  it.each(codes)("%s names at least one known side", (code) => {
    const sides = CODES.get(code)!.sides;
    expect(sides.length).toBeGreaterThan(0);
    for (const side of sides) expect(SIDES.has(side)).toBe(true);
    expect(new Set(sides).size).toBe(sides.length);
  });

  it.each(codes)("%s carries one copy of its text when shared", (code) => {
    const entry = CODES.get(code)!;
    if (entry.sides.length < 2 || entry.messages.length > 0) return;
    // No shared text: every side it names has to bring its own, with a reason.
    const sideOnly = entry.sideOnlyMessages ?? {};
    expect(Object.keys(sideOnly).sort()).toEqual([...entry.sides].sort());
    expect(entry.note ?? "").not.toBe("");
  });

  it.each(codes)("%s states its reason when one-sided", (code) => {
    const entry = CODES.get(code)!;
    if (entry.sides.length !== 1) return;
    expect(entry.note ?? "").not.toBe("");
  });

  it.each(codes)("%s keeps its side-only text honest", (code) => {
    const entry = CODES.get(code)!;
    const sideOnly = entry.sideOnlyMessages;
    if (!sideOnly) return;
    for (const [side, texts] of Object.entries(sideOnly)) {
      expect(entry.sides).toContain(side);
      expect(texts?.length ?? 0).toBeGreaterThan(0);
    }
    expect(entry.note ?? "").not.toBe("");
  });

  it("lists every code once, in order", () => {
    const listed = TABLE.codes.map((entry) => entry.code);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual([...listed].sort());
  });

  it("pins the text around a template's slots", () => {
    expect(
      matchesTemplate(
        "Interrupt '{}' has expired.",
        "Interrupt 'a' has expired.",
      ),
    ).toBe(true);
    expect(
      matchesTemplate(
        "Interrupt '{}' has expired.",
        "Interrupt 'a' has expired",
      ),
    ).toBe(false);
    expect(
      matchesTemplate("Interrupt '{}' has expired.", "interrupt 'a' expired."),
    ).toBe(false);
  });

  /**
   * The backstop. A literal search, in the only direction data can support.
   *
   * A code named here for TypeScript that no longer appears in `src` has been
   * renamed or removed without the table following. The reverse, a code added
   * to the source and never written down here, is not caught: see the
   * error-code contract section of `ARCHITECTURE.md`.
   */
  it("still finds every code on this side in the source", () => {
    const missing = [...CODES.values()]
      .filter(
        (entry) =>
          entry.sides.includes(SIDE) &&
          !SOURCES.some((source) => source.includes(`"${entry.code}"`)),
      )
      .map((entry) => entry.code);
    expect(missing).toEqual([]);
  });
});
