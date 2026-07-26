// F-SL4 recurrence guard: shipped docs must reference the canonical awslabs
// repo, never the plauzy/ fork. Mirrors the repo norm of pairing a content-bug
// fix (P0-3) with a mechanical guard so it cannot silently regress.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("shipped docs canonical links", () => {
  it("contain no plauzy/ GitHub URLs", () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(packageRoot)) {
      const text = readFileSync(file, "utf8");
      if (/github\.com\/plauzy\//.test(text)) offenders.push(file);
    }
    expect(offenders, `plauzy/ URLs found in: ${offenders.join(", ")}`).toEqual([]);
  });
});
