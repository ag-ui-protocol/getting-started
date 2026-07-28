#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const concurrently = require("concurrently");

// 1.2.3: the in-memory dev server provisions persistence itself, so graphs no
// longer need to compile their own checkpointer for threads.getState (1.1.13
// 500'd with "No checkpointer set" once the compiled MemorySaver was removed).
// Supersedes the old 1.1.13 pin that dodged the 1.1.14 schema-extraction regression.
const LANGGRAPH_CLI_VERSION = "1.2.3";

// Parse command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const dryRun = args.includes("--dry-run");

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
Usage: node run-dojo-everything.js [options]

Options:
  --dry-run       Show what would be started without actually running
  --only list     Comma-separated services to include (defaults to all)
  --exclude list  Comma-separated services to exclude
  --help, -h      Show this help message

Examples:
  node run-dojo-everything.js
  node run-dojo-everything.js --dry-run
  node run-dojo-everything.js --only dojo,server-starter
  node run-dojo-everything.js --exclude crew-ai,mastra
`);
  process.exit(0);
}

const gitRoot = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();
const integrationsRoot = path.join(gitRoot, "integrations");
const middlewaresRoot = path.join(gitRoot, "middlewares");

// Define all runnable services keyed by a stable id
const ALL_SERVICES = {
  "server-starter": [
    {
      command: "uv run dev",
      name: "Server Starter",
      cwd: path.join(integrationsRoot, "server-starter/python/examples"),
      env: { PORT: 8000 },
    },
  ],
  "server-starter-all": [
    {
      command: "uv run dev",
      name: "Server AF",
      cwd: path.join(
        integrationsRoot,
        "server-starter-all-features/python/examples",
      ),
      env: { PORT: 8001 },
    },
  ],
  ag2: [
    {
      command: "uv run dev",
      name: "AG2",
      cwd: path.join(integrationsRoot, "ag2/python/examples"),
      env: { PORT: 8018 },
    },
  ],
  agno: [
    {
      command: "uv run dev",
      name: "Agno",
      cwd: path.join(integrationsRoot, "agno/python/examples"),
      env: { PORT: 8002 },
    },
  ],
  "crew-ai": [
    {
      command: "poetry run dev",
      name: "CrewAI",
      cwd: path.join(integrationsRoot, "crew-ai/python"),
      env: { PORT: 8003 },
    },
  ],
  "langgraph-fastapi": [
    {
      command: "uv run dev",
      name: "LG FastAPI",
      cwd: path.join(integrationsRoot, "langgraph/python/examples"),
      env: { PORT: 8004 },
    },
  ],
  "langgraph-platform-python": [
    {
      command: `pnpx @langchain/langgraph-cli@${LANGGRAPH_CLI_VERSION} dev --no-browser --host 127.0.0.1 --port 8005`,
      name: "LG Platform Py",
      cwd: path.join(integrationsRoot, "langgraph/python/examples"),
      env: {
        PORT: 8005,
        // langgraph-api 0.7.97 requires DATABASE_URI at import time,
        // breaking the in-memory dev server. Pin until upstream fixes it.
        UV_CONSTRAINT: path.join(
          integrationsRoot,
          "langgraph/python/examples/constraints.txt",
        ),
      },
    },
  ],
  "langgraph-platform-typescript": [
    {
      command: `pnpx @langchain/langgraph-cli@${LANGGRAPH_CLI_VERSION} dev --no-browser --host 127.0.0.1 --port 8006`,
      name: "LG Platform TS",
      cwd: path.join(integrationsRoot, "langgraph/typescript/examples"),
      env: { PORT: 8006 },
    },
  ],
  langroid: [
    {
      command: "uv run dev",
      name: "Langroid",
      cwd: path.join(integrationsRoot, "langroid/python/examples"),
      env: { PORT: 8021 },
    },
  ],
  "llama-index": [
    {
      command: "uv run dev",
      name: "Llama Index",
      cwd: path.join(integrationsRoot, "llama-index/python/examples"),
      env: { PORT: 8007 },
    },
  ],
  mastra: [
    {
      command: "npm run dev",
      name: "Mastra",
      cwd: path.join(integrationsRoot, "mastra/typescript/examples"),
      env: {
        PORT: 8008,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "test-key",
        ...(!process.env.OPENAI_API_KEY && {
          OPENAI_BASE_URL: "http://localhost:5555/v1",
        }),
      },
    },
  ],
  "pydantic-ai": [
    {
      command: "uv run dev",
      name: "Pydantic AI",
      cwd: path.join(integrationsRoot, "pydantic-ai/python/examples"),
      env: { PORT: 8009 },
    },
  ],
  "aws-strands": [
    {
      command: "poetry run dev",
      name: "AWS Strands",
      cwd: path.join(integrationsRoot, "aws-strands/python/examples"),
      env: { PORT: 8017 },
    },
  ],
  "aws-strands-typescript": [
    {
      command: "pnpm run dojo",
      name: "AWS Strands (TypeScript)",
      cwd: path.join(integrationsRoot, "aws-strands/typescript/examples"),
      env: { PORT: 8022 },
    },
  ],
  "adk-middleware": [
    {
      command: "uv run dev",
      name: "ADK Middleware",
      cwd: path.join(integrationsRoot, "adk-middleware/python/examples"),
      env: { PORT: 8010 },
    },
  ],
  "a2a-middleware": [
    {
      command: "uv run buildings_management.py",
      name: "A2A Middleware: Buildings Management",
      cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
      env: { PORT: 8011 },
    },
    {
      command: "uv run finance.py",
      name: "A2A Middleware: Finance",
      cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
      env: { PORT: 8012 },
    },
    {
      command: "uv run it.py",
      name: "A2A Middleware: IT",
      cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
      env: { PORT: 8013 },
    },
    {
      command: "uv run orchestrator.py",
      name: "A2A Middleware: Orchestrator",
      cwd: path.join(middlewaresRoot, "a2a-middleware/examples"),
      env: { PORT: 8014 },
    },
  ],
  "openai-agents-python": [
    {
      command: "uv run dev",
      name: "OpenAI Agents SDK (Python)",
      cwd: path.join(integrationsRoot, "openai-agents/python/examples"),
      env: { PORT: 8024 },
    },
  ],
  "claude-agent-sdk-python": [
    {
      command: "uv run dev",
      name: "Claude Agent SDK (Python)",
      cwd: path.join(integrationsRoot, "claude-agent-sdk/python/examples"),
      env: {
        PORT: 8019,
        ANTHROPIC_API_KEY:
          process.env.ANTHROPIC_API_KEY ||
          "sk-ant-api03-test-key-for-llmock-000000000000000000000000000000000000000000000000-000000000000AA",
        ...(!process.env.ANTHROPIC_API_KEY && {
          ANTHROPIC_BASE_URL: "http://localhost:5555",
        }),
      },
    },
  ],
  "claude-agent-sdk-typescript": [
    {
      command: "npx tsx examples/server.ts",
      name: "Claude Agent SDK (TypeScript)",
      cwd: path.join(integrationsRoot, "claude-agent-sdk/typescript"),
      env: {
        PORT: 8020,
        ANTHROPIC_API_KEY:
          process.env.ANTHROPIC_API_KEY ||
          "sk-ant-api03-test-key-for-llmock-000000000000000000000000000000000000000000000000-000000000000AA",
        ...(!process.env.ANTHROPIC_API_KEY && {
          ANTHROPIC_BASE_URL: "http://localhost:5555",
        }),
      },
    },
  ],
  "microsoft-agent-framework-python": [
    {
      command: "uv run dev",
      name: "Microsoft Agent Framework (Python)",
      cwd: path.join(
        integrationsRoot,
        "microsoft-agent-framework/python/examples",
      ),
      env: { PORT: 8015 },
    },
  ],
  "microsoft-agent-framework-dotnet": [
    {
      command:
        'dotnet run --project AGUIDojoServer/AGUIDojoServer.csproj --urls "http://localhost:8016" --no-build',
      name: "Microsoft Agent Framework (.NET)",
      cwd: path.join(
        integrationsRoot,
        "microsoft-agent-framework/dotnet/examples",
      ),
      env: { PORT: 8016 },
    },
  ],
  "ag-ui-dotnet": [
    {
      command:
        'dotnet run --project AGUIDojoServer/AGUIDojoServer.csproj --urls "http://localhost:8023" --no-build',
      name: "AG-UI .NET SDK",
      cwd: path.join(gitRoot, "sdks/dotnet/samples/AGUIClientServer"),
      env: { PORT: 8023 },
    },
  ],
  dojo: [
    {
      command: "pnpm run start",
      name: "Dojo",
      cwd: path.join(gitRoot, "apps/dojo"),
      env: {
        PORT: 9999,
        AG2_URL: "http://localhost:8018",
        SERVER_STARTER_URL: "http://localhost:8000",
        SERVER_STARTER_ALL_FEATURES_URL: "http://localhost:8001",
        AGNO_URL: "http://localhost:8002",
        CREW_AI_URL: "http://localhost:8003",
        LANGGRAPH_FAST_API_URL: "http://localhost:8004",
        LANGGRAPH_PYTHON_URL: "http://localhost:8005",
        LANGGRAPH_TYPESCRIPT_URL: "http://localhost:8006",
        LLAMA_INDEX_URL: "http://localhost:8007",
        MASTRA_URL: "http://localhost:8008",
        PYDANTIC_AI_URL: "http://localhost:8009",
        ADK_MIDDLEWARE_URL: "http://localhost:8010",
        A2A_MIDDLEWARE_BUILDINGS_MANAGEMENT_URL: "http://localhost:8011",
        A2A_MIDDLEWARE_FINANCE_URL: "http://localhost:8012",
        A2A_MIDDLEWARE_IT_URL: "http://localhost:8013",
        A2A_MIDDLEWARE_ORCHESTRATOR_URL: "http://localhost:8014",
        AGENT_FRAMEWORK_PYTHON_URL: "http://localhost:8015",
        AGENT_FRAMEWORK_DOTNET_URL: "http://localhost:8016",
        AGUI_DOTNET_URL: "http://localhost:8023",
        AWS_STRANDS_URL: "http://localhost:8017",
        AWS_STRANDS_TYPESCRIPT_URL: "http://localhost:8022",
        CLAUDE_AGENT_SDK_PYTHON_URL: "http://localhost:8019",
        CLAUDE_AGENT_SDK_TYPESCRIPT_URL: "http://localhost:8020",
        LANGROID_URL: "http://localhost:8021",
        OPENAI_AGENTS_PYTHON_URL: "http://localhost:8024",
        NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE:
          "cpkdojo.local___CopilotKit Feature Viewer",
      },
    },
  ],
  "dojo-dev": [
    {
      command: "pnpm run dev --filter=demo-viewer...",
      name: "Dojo (dev)",
      cwd: gitRoot,
      env: {
        PORT: 9999,
        AG2_URL: "http://localhost:8018",
        SERVER_STARTER_URL: "http://localhost:8000",
        SERVER_STARTER_ALL_FEATURES_URL: "http://localhost:8001",
        AGNO_URL: "http://localhost:8002",
        CREW_AI_URL: "http://localhost:8003",
        LANGGRAPH_FAST_API_URL: "http://localhost:8004",
        LANGGRAPH_PYTHON_URL: "http://localhost:8005",
        LANGGRAPH_TYPESCRIPT_URL: "http://localhost:8006",
        LLAMA_INDEX_URL: "http://localhost:8007",
        MASTRA_URL: "http://localhost:8008",
        PYDANTIC_AI_URL: "http://localhost:8009",
        ADK_MIDDLEWARE_URL: "http://localhost:8010",
        A2A_MIDDLEWARE_BUILDINGS_MANAGEMENT_URL: "http://localhost:8011",
        A2A_MIDDLEWARE_FINANCE_URL: "http://localhost:8012",
        A2A_MIDDLEWARE_IT_URL: "http://localhost:8013",
        A2A_MIDDLEWARE_ORCHESTRATOR_URL: "http://localhost:8014",
        AGENT_FRAMEWORK_PYTHON_URL: "http://localhost:8015",
        AGENT_FRAMEWORK_DOTNET_URL: "http://localhost:8016",
        AGUI_DOTNET_URL: "http://localhost:8023",
        AWS_STRANDS_URL: "http://localhost:8017",
        AWS_STRANDS_TYPESCRIPT_URL: "http://localhost:8022",
        CLAUDE_AGENT_SDK_PYTHON_URL: "http://localhost:8019",
        CLAUDE_AGENT_SDK_TYPESCRIPT_URL: "http://localhost:8020",
        LANGROID_URL: "http://localhost:8021",
        OPENAI_AGENTS_PYTHON_URL: "http://localhost:8024",
        NEXT_PUBLIC_CUSTOM_DOMAIN_TITLE:
          "cpkdojo.local___CopilotKit Feature Viewer",
      },
    },
  ],
};

function printDryRunServices(procs) {
  console.log("Dry run - would start the following services:");
  procs.forEach((proc) => {
    console.log(`  - ${proc.name} (${proc.cwd})`);
    console.log(`    Command: ${proc.command}`);
    console.log(`    Environment variables:`);
    if (proc.env) {
      Object.entries(proc.env).forEach(([key, value]) => {
        console.log(`      ${key}: ${value}`);
      });
    } else {
      console.log("      No environment variables specified.");
    }
    console.log("");
  });
  process.exit(0);
}

async function main() {
  // determine selection
  let selectedKeys = Object.keys(ALL_SERVICES);
  if (onlyList && onlyList.length) {
    selectedKeys = onlyList;
  }
  if (excludeList && excludeList.length) {
    selectedKeys = selectedKeys.filter((k) => !excludeList.includes(k));
  }

  if (selectedKeys.includes("dojo") && selectedKeys.includes("dojo-dev")) {
    selectedKeys = selectedKeys.filter((x) => x != "dojo-dev");
  }

  // LLMock: inject OPENAI_BASE_URL, OPENAI_API_BASE, and OPENAI_API_KEY
  // defaults so all framework agents route OpenAI API calls to the mock server
  // when running.  OPENAI_API_BASE is the legacy env var used by llama-index
  // (via resolve_openai_credentials) and litellm (used by crew-ai).
  const openaiEnvDefaults = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "http://localhost:5555/v1",
    OPENAI_API_BASE: process.env.OPENAI_API_BASE || "http://localhost:5555/v1",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "sk-mock",
    OPENAI_CHAT_MODEL_ID: process.env.OPENAI_CHAT_MODEL_ID || "gpt-5.5",
  };

  // LLMock: inject GOOGLE_GEMINI_BASE_URL so ADK middleware agents (which keep
  // their native Gemini model strings) route to the mock server via the genai
  // client's built-in env var support. No /v1 suffix — the genai client appends
  // the full /v1beta/models/{model}:generateContent path itself.
  const geminiEnvDefaults = {
    GOOGLE_GEMINI_BASE_URL:
      process.env.GOOGLE_GEMINI_BASE_URL || "http://localhost:5555",
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || "fake-gemini-key",
  };

  // Build processes, warn for unknown keys
  const procs = [];
  for (const key of selectedKeys) {
    const svcs = ALL_SERVICES[key];
    if (!svcs || svcs.length === 0) {
      console.warn(`Skipping unknown service: ${key}`);
      continue;
    }
    for (const svc of svcs) {
      svc.env = { ...openaiEnvDefaults, ...geminiEnvDefaults, ...svc.env };
    }
    procs.push(...svcs);
  }

  if (dryRun) {
    printDryRunServices(procs);
  }

  console.log("Starting services: ", procs.map((p) => p.name).join(", "));

  const { result } = concurrently(procs, {
    killOthersOn: ["failure", "success"],
  });

  result
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
