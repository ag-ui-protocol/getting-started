import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isTraceEvent, type TraceEvent } from "../lib/event-trace-events";
import { getEventTraceDestination } from "../lib/event-trace-golden";
import {
  type EventTraceUpdateCandidate,
  planEventTraceUpdates,
  renderEventTraceModule,
  summarizeEventTraceDiff,
} from "../lib/event-trace-update";

type CliOptions = {
  all: boolean;
  spec?: string;
  reason: string;
};

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = join(e2eRoot, "tests");
const stagingDirectory = join(e2eRoot, ".event-trace-update");

function readOptionValue(args: readonly string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(args: readonly string[]): CliOptions {
  let all = false;
  let spec: string | undefined;
  let reason: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--spec") {
      spec = readOptionValue(args, index, "--spec");
      index += 1;
    } else if (arg === "--reason") {
      reason = readOptionValue(args, index, "--reason");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (all === Boolean(spec)) {
    throw new Error("Choose exactly one of --all or --spec <name>");
  }
  if (!reason?.trim()) {
    throw new Error("Event trace updates require --reason <explanation>");
  }
  if (spec && !/^[A-Za-z0-9_-]+$/.test(spec)) {
    throw new Error(`Invalid spec name: ${spec}`);
  }

  return { all, spec, reason };
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    // Missing optional specs and not-yet-created golden files are expected.
    return false;
  }
}

function laneTarget(lane: "typescript" | "python", options: CliOptions) {
  const directory =
    lane === "typescript" ? "langgraphTypescriptTests" : "langgraphPythonTests";
  return options.all
    ? join("tests", directory)
    : join("tests", directory, `${options.spec}.spec.ts`);
}

function runLane(lane: "typescript" | "python", target: string) {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    executable,
    ["exec", "playwright", "test", target, "--retries=0"],
    {
      cwd: e2eRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        EVENT_TRACE_UPDATE_LANE: lane,
        EVENT_TRACE_UPDATE_STAGING_DIR: stagingDirectory,
        PLAYWRIGHT_SUITE: `langgraph-${lane}`,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `${lane} Event trace update lane failed; no golden files were written`,
    );
  }
}

async function findJsonFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findJsonFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function parseCandidate(
  value: unknown,
  path: string,
): EventTraceUpdateCandidate {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lane" in value) ||
    typeof value.lane !== "string" ||
    !("sourceUrl" in value) ||
    typeof value.sourceUrl !== "string" ||
    !("journeyKey" in value) ||
    typeof value.journeyKey !== "string" ||
    !("events" in value) ||
    !Array.isArray(value.events) ||
    !value.events.every(isTraceEvent)
  ) {
    throw new Error(`Invalid Event trace update candidate: ${path}`);
  }

  return {
    lane: value.lane,
    sourceUrl: value.sourceUrl,
    journeyKey: value.journeyKey,
    events: value.events,
  };
}

async function readCandidates() {
  const files = await findJsonFiles(stagingDirectory);
  return Promise.all(
    files.map(async (path) => {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return parseCandidate(value, path);
    }),
  );
}

function goldenExportName(path: string) {
  const stem = basename(path, ".event-trace.ts");
  const camel = stem.replaceAll(/[^A-Za-z0-9_$]+(.)/g, (_, character) =>
    character.toUpperCase(),
  );
  return `${camel}EventTrace`;
}

function goldenImportPath(path: string) {
  const helper = join(e2eRoot, "event-trace-test.ts");
  const importPath = relative(dirname(path), helper)
    .split(sep)
    .join("/")
    .replace(/\.ts$/, "");
  return importPath.startsWith(".") ? importPath : `./${importPath}`;
}

async function readExistingJourneys(
  sourceUrl: string,
): Promise<{ readonly [journeyKey: string]: readonly TraceEvent[] }> {
  if (!(await exists(fileURLToPath(sourceUrl)))) return {};

  const goldenModule: unknown = await import(sourceUrl);
  if (typeof goldenModule !== "object" || goldenModule === null) return {};

  const journeys: { [journeyKey: string]: readonly TraceEvent[] } = {};
  for (const exported of Object.values(goldenModule)) {
    if (typeof exported !== "object" || exported === null) continue;
    for (const value of Object.values(exported)) {
      if (!Array.isArray(value) || !value.every(isTraceEvent)) continue;
      const destination = getEventTraceDestination(value);
      if (destination?.sourceUrl === sourceUrl) {
        journeys[destination.journeyKey] = value;
      }
    }
  }
  return journeys;
}

function validateGoldenPath(sourceUrl: string) {
  const path = resolve(fileURLToPath(sourceUrl));
  if (!isAbsolute(path) || !path.startsWith(`${testsRoot}${sep}`)) {
    throw new Error(`Refusing to update golden outside ${testsRoot}: ${path}`);
  }
  if (!path.endsWith(".event-trace.ts")) {
    throw new Error(`Event trace must end in .event-trace.ts: ${path}`);
  }
  return path;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!process.env.BASE_URL) {
    throw new Error(
      "BASE_URL is required; start Dojo and both selected LangGraph backends first",
    );
  }

  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  const ranLanes: Array<"typescript" | "python"> = [];
  for (const lane of ["typescript", "python"] as const) {
    const target = laneTarget(lane, options);
    if (!(await exists(join(e2eRoot, target)))) continue;
    ranLanes.push(lane);
    runLane(lane, target);
  }
  if (ranLanes.length === 0) {
    throw new Error(
      options.spec
        ? `No matching LangGraph spec found for ${options.spec}`
        : "No LangGraph Event trace test directories were found",
    );
  }

  const candidates = await readCandidates();
  if (candidates.length === 0) {
    throw new Error("The selected tests produced no Event trace candidates");
  }
  for (const lane of ranLanes) {
    if (!candidates.some((candidate) => candidate.lane === lane)) {
      throw new Error(
        `${lane} completed without leaving event trace candidates; no golden files were written`,
      );
    }
  }

  const updates = planEventTraceUpdates(candidates);
  const pendingWrites: Array<{
    path: string;
    temporaryPath: string;
    content: string;
  }> = [];

  for (const update of updates) {
    const path = validateGoldenPath(update.sourceUrl);
    const previous = await readExistingJourneys(update.sourceUrl);
    const summary = summarizeEventTraceDiff(previous, update.journeys);
    const label = relative(e2eRoot, path);
    if (summary.length === 0) {
      console.log(`${label}: no semantic changes`);
      continue;
    }

    console.log(`\n${label}`);
    for (const line of summary) console.log(`  ${line}`);

    pendingWrites.push({
      path,
      temporaryPath: `${path}.event-trace-update-tmp`,
      content: await renderEventTraceModule({
        exportName: goldenExportName(path),
        importPath: goldenImportPath(path),
        reason: options.reason,
        journeys: update.journeys,
      }),
    });
  }

  for (const pending of pendingWrites) {
    await writeFile(pending.temporaryPath, pending.content, "utf8");
  }
  for (const pending of pendingWrites) {
    await rename(pending.temporaryPath, pending.path);
  }

  console.log(`\nUpdated ${pendingWrites.length} Event trace file(s).`);
  console.log(
    "Review every semantic change and first ask whether the implementation regressed.",
  );
}

await main();
