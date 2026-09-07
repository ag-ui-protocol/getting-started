#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const concurrently = require("concurrently");

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const dryRun = args.includes("--dry-run");

// selection controls
function parseList(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

const onlyList = parseList("--only") || parseList("--include");
const excludeList = parseList("--exclude") || [];

if (showHelp) {
  console.log(`
Usage: node prep-dojo-everything.js [options]

Options:
  --dry-run       Show what would be installed without actually running
  --only list     Comma-separated services to include (defaults to all)
  --exclude list  Comma-separated services to exclude
  --help, -h      Show this help message

Examples:
  node prep-dojo-everything.js
  node prep-dojo-everything.js --dry-run
  node prep-dojo-everything.js --only dojo,agno
  node prep-dojo-everything.js --exclude crew-ai,mastra
`);
  process.exit(0);
}

const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
const integrationsRoot = path.join(gitRoot, "integrations");
const middlewaresRoot = path.join(gitRoot, "middlewares");

// Define all prep targets keyed by a stable id
const ALL_TARGETS = {
  "server-starter": {
    command: "uv sync",
    name: "Server Starter",
    cwd: path.join(integrationsRoot, "server-starter/python/examples"),
  },
  "server-starter-all": {
    command: "uv sync",
    name: "Server AF",
    cwd: path.join(integrationsRoot, "server-starter-all-features/python/examples"),
  },
  ag2: {
    command: "uv sync",
    name: "AG2",
    cwd: path.join(integrationsRoot, "ag2/python/examples"),
  },
  agno: {
    command: "uv sync",
    name: "Agno",
    cwd: path.join(integrationsRoot, "agno/python/examples"),
  },
  "crew-ai": {
    command: "uv sync",
    name: "CrewAI",
    cwd: path.join(integrationsRoot, "crew-ai/python/examples"),
  },
  'langroid': {
    command: 'uv sync',
    name: 'Langroid',
    cwd: path.join(integrationsRoot, 'langroid/python/examples'),
  },
  "langgraph-fastapi": {
    command: "uv sync",
    name: "LG FastAPI",
    cwd: path.join(integrationsRoot, "langgraph/python/examples"),
  },
  "langgraph-platform-typescript": {
    command: "pnpm install",
    name: "LG Platform TS",
    cwd: path.join(integrationsRoot, "langgraph/typescript/examples"),
  },
  "llama-index": {
    command: "uv sync",
    name: "Llama Index",
    cwd: path.join(integrationsRoot, "llama-index/python/examples"),
  },
  mastra: {
    command: "pnpm install --no-frozen-lockfile",
    name: "Mastra",
    cwd: path.join(integrationsRoot, "mastra/typescript/examples"),
  },
  "pydantic-ai": {
    command: "uv sync",
    name: "Pydantic AI",
    cwd: path.join(integrationsRoot, "pydantic-ai/python/examples"),
  },
  "aws-strands": {
    command: "poetry install",
    name: "AWS Strands",
    cwd: path.join(integrationsRoot, "aws-strands/python/examples"),
  },
  "aws-strands-typescript": {
    command: "pnpm install",
    name: "AWS Strands (TypeScript)",
    cwd: path.join(integrationsRoot, "aws-strands/typescript/examples"),
  },
  "adk-middleware": {
    command: "uv sync",
    name: "ADK Middleware",
    cwd: path.join(integrationsRoot, "adk-middleware/python/examples"),
  },
  "adk-middleware-java": {
    command:
      "mvn -q -DskipTests install && mvn -q -DskipTests -f examples/pom.xml package",
    name: "ADK Middleware (Java)",
    cwd: path.join(integrationsRoot, "adk-middleware/java"),
  },
  "a2a-middleware": {
    command: "uv sync",
    name: "A2A Middleware",
    cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
  },
  dojo: {
    command: "pnpm install --no-frozen-lockfile && npx nx run demo-viewer:build",
    name: "Dojo",
    cwd: gitRoot,
  },
  "dojo-dev": {
    command: "pnpm install --no-frozen-lockfile && npx nx run-many -t build --exclude=demo-viewer",
    name: "Dojo (dev)",
    cwd: gitRoot,
  },
  "claude-agent-sdk-python": {
    command: "uv sync",
    name: "Claude Agent SDK (Python)",
    cwd: path.join(integrationsRoot, "claude-agent-sdk/python/examples"),
  },
  "claude-agent-sdk-typescript": {
    command: "pnpm install",
    name: "Claude Agent SDK (TypeScript)",
    cwd: path.join(integrationsRoot, "claude-agent-sdk/typescript"),
  },
  "claude-managed-agents-dotnet": {
    command:
      "dotnet restore AGUIDojoServer/AGUIDojoServer.csproj && dotnet build AGUIDojoServer/AGUIDojoServer.csproj",
    name: "Claude Managed Agents (.NET)",
    cwd: path.join(integrationsRoot, "claude-managed-agents/dotnet/examples"),
  },
  "claude-managed-agents-python": {
    command: "uv sync",
    name: "Claude Managed Agents (Python)",
    cwd: path.join(integrationsRoot, "claude-managed-agents/python/examples"),
  },
  "claude-managed-agents-typescript": {
    command: "pnpm install",
    name: "Claude Managed Agents (TypeScript)",
    cwd: path.join(integrationsRoot, "claude-managed-agents/typescript"),
  },
  "microsoft-agent-framework-python": {
    command: "uv sync",
    name: "Microsoft Agent Framework (Python)",
    cwd: path.join(integrationsRoot, "microsoft-agent-framework/python/examples"),
  },
  "microsoft-agent-framework-dotnet": {
    command: "dotnet restore AGUIDojoServer/AGUIDojoServer.csproj && dotnet build AGUIDojoServer/AGUIDojoServer.csproj",
    name: "Microsoft Agent Framework (.NET)",
    cwd: path.join(integrationsRoot, "microsoft-agent-framework/dotnet/examples"),
  },
  "ag-ui-dotnet": {
    command: "dotnet restore AGUIDojoServer/AGUIDojoServer.csproj && dotnet build AGUIDojoServer/AGUIDojoServer.csproj",
    name: "AG-UI .NET SDK",
    cwd: path.join(gitRoot, "sdks/dotnet/samples/AGUIClientServer"),
  },
};

function printDryRunServices(procs) {
  console.log("Dry run - would install dependencies for the following services:");
  procs.forEach((proc) => {
    console.log(`  - ${proc.name} (${proc.cwd})`);
    console.log(`    Command: ${proc.command}`);
    console.log("");
  });
  process.exit(0);
}

async function main() {
  // determine selection
  let selectedKeys = Object.keys(ALL_TARGETS);
  if (onlyList && onlyList.length) {
    selectedKeys = onlyList;
  }
  if (excludeList && excludeList.length) {
    selectedKeys = selectedKeys.filter((k) => !excludeList.includes(k));
  }

  if (selectedKeys.includes("dojo") && selectedKeys.includes("dojo-dev")) {
    selectedKeys= selectedKeys.filter(x => x != "dojo-dev");
  }

  // Build procs list, warning on unknown keys
  const procs = [];
  for (const key of selectedKeys) {
    const target = ALL_TARGETS[key];
    if (!target) {
      console.warn(`Skipping unknown service: ${key}`);
      continue;
    }
    procs.push(target);
  }

  if (dryRun) {
    printDryRunServices(procs);
  }

  // Separate pnpm targets from others to avoid concurrent install races.
  // Multiple pnpm installs within the same workspace race on the shared
  // node_modules/.pnpm/ directory, causing ENOENT errors.
  const pnpmProcs = [];
  const otherProcs = [];

  for (const proc of procs) {
    if (proc.command.startsWith("pnpm")) {
      pnpmProcs.push(proc);
    } else {
      otherProcs.push(proc);
    }
  }

  // Run pnpm targets sequentially to avoid races on shared node_modules
  for (const proc of pnpmProcs) {
    console.log(`\n=== [${proc.name}] ${proc.command} ===`);
    try {
      execSync(proc.command, { cwd: proc.cwd, stdio: "inherit" });
    } catch (err) {
      console.error(`[${proc.name}] Failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Run remaining targets concurrently (uv, poetry, dotnet — all independent)
  if (otherProcs.length === 0) {
    process.exit(0);
  }

  const { result } = concurrently(otherProcs);

  result
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
