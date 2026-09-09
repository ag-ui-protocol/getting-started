import fs from "fs";
import path from "path";
import { menuIntegrations } from "../src/menu";

// Map menuIntegrations to the format needed for content generation
const agentConfigs = menuIntegrations.map((integration) => ({
  id: integration.id,
  agentKeys: [...integration.features],
}));

const featureFiles = ["page.tsx", "style.css", "README.mdx"];

async function getFile(_filePath: string | undefined, _fileName?: string) {
  if (!_filePath) {
    console.warn(`File path is undefined, skipping.`);
    return {};
  }

  const fileName = _fileName ?? path.basename(_filePath);
  const filePath = _fileName ? path.join(_filePath, fileName) : _filePath;

  // Check if it's a remote URL
  const isRemoteUrl =
    _filePath.startsWith("http://") || _filePath.startsWith("https://");

  let content: string;

  try {
    if (isRemoteUrl) {
      // Convert GitHub URLs to raw URLs for direct file access
      let fetchUrl = _filePath;
      if (_filePath.includes("github.com") && _filePath.includes("/blob/")) {
        fetchUrl = _filePath
          .replace("github.com", "raw.githubusercontent.com")
          .replace("/blob/", "/");
      }

      // Fetch remote file content
      console.log(`Fetching remote file: ${fetchUrl}`);
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        console.warn(
          `Failed to fetch remote file: ${fetchUrl}, status: ${response.status}`,
        );
        return {};
      }
      content = await response.text();
    } else {
      // Handle local file
      if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}, skipping.`);
        return {};
      }
      content = fs.readFileSync(filePath, "utf8");
    }

    const extension = fileName.split(".").pop();
    let language = extension;
    if (extension === "py") language = "python";
    else if (extension === "cs") language = "csharp";
    else if (extension === "css") language = "css";
    else if (extension === "md" || extension === "mdx") language = "markdown";
    else if (extension === "tsx") language = "typescript";
    else if (extension === "js") language = "javascript";
    else if (extension === "json") language = "json";
    else if (extension === "yaml" || extension === "yml") language = "yaml";
    else if (extension === "toml") language = "toml";

    return {
      name: fileName,
      content,
      language,
      type: "file",
    };
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return {};
  }
}

const FEATURE_BASE = path.join(__dirname, "../src/app/[integrationId]/feature");

function resolveFeatureDir(featureId: string): string {
  const v1Path = path.join(FEATURE_BASE, "(v1)", featureId);
  if (fs.existsSync(v1Path)) return v1Path;
  return path.join(FEATURE_BASE, "(v2)", featureId);
}

async function getFeatureFrontendFiles(featureId: string) {
  const featurePath = resolveFeatureDir(featureId);
  const retrievedFiles = [];

  for (const fileName of featureFiles) {
    retrievedFiles.push(await getFile(featurePath, fileName));
  }

  return retrievedFiles;
}

const integrationsFolderPath = "../../../integrations";
const middlewaresFolderPath = "../../../middlewares";
const sdksFolderPath = "../../../sdks";
const agentFilesMapper: Record<
  string,
  (agentKeys: string[]) => Record<string, string[]>
> = {
  "middleware-starter": () => ({
    agentic_chat: [
      path.join(
        __dirname,
        middlewaresFolderPath,
        `/middleware-starter/src/index.ts`,
      ),
    ],
  }),
  "pydantic-ai": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/pydantic-ai/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "server-starter": () => ({
    agentic_chat: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/server-starter/python/examples/example_server/__init__.py`,
      ),
    ],
  }),
  "server-starter-all-features": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/server-starter-all-features/python/examples/example_server/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  mastra: () => ({
    agentic_chat: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/agentic-chat.ts`,
      ),
    ],
    backend_tool_rendering: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/backend-tool-rendering.ts`,
      ),
    ],
    human_in_the_loop: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/human-in-the-loop.ts`,
      ),
    ],
    interrupt: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/interrupt.ts`,
      ),
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/tools/schedule-meeting-tool.ts`,
      ),
    ],
    tool_based_generative_ui: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/tool-based-generative-ui.ts`,
      ),
    ],
    a2ui_dynamic_schema: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/a2ui.ts`,
      ),
    ],
    a2ui_recovery: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/a2ui.ts`,
      ),
    ],
    a2ui_fixed_schema: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/mastra/typescript/examples/src/mastra/agents/a2ui-fixed.ts`,
      ),
    ],
  }),

  "mastra-agent-local": () => ({
    agentic_chat: [
      path.join(__dirname, "../src/mastra/agents/agentic-chat.ts"),
    ],
    human_in_the_loop: [
      path.join(__dirname, "../src/mastra/agents/human-in-the-loop.ts"),
    ],
    backend_tool_rendering: [
      path.join(__dirname, "../src/mastra/agents/backend-tool-rendering.ts"),
    ],
    interrupt: [
      path.join(__dirname, "../src/mastra/agents/interrupt.ts"),
      path.join(__dirname, "../src/mastra/tools.ts"),
    ],
    shared_state: [
      path.join(__dirname, "../src/mastra/agents/shared-state.ts"),
    ],
    tool_based_generative_ui: [
      path.join(__dirname, "../src/mastra/agents/tool-based-generative-ui.ts"),
    ],
    a2ui_dynamic_schema: [path.join(__dirname, "../src/mastra/agents/a2ui.ts")],
    a2ui_recovery: [path.join(__dirname, "../src/mastra/agents/a2ui.ts")],
    a2ui_fixed_schema: [
      path.join(__dirname, "../src/mastra/agents/a2ui-fixed.ts"),
    ],
  }),

  "vercel-ai-sdk": () => ({
    agentic_chat: [
      // Show the main agent class (constructor + run() wiring streamText
      // into AG-UI) and the stream handler (the actual AI SDK v7 fullStream
      // → AG-UI event mapping). These are the two files a reader needs to
      // understand how the integration works end-to-end.
      path.join(
        __dirname,
        integrationsFolderPath,
        `/vercel-ai-sdk/typescript/src/vercel-ai-sdk.ts`,
      ),
      path.join(
        __dirname,
        integrationsFolderPath,
        `/vercel-ai-sdk/typescript/src/stream-handler.ts`,
      ),
    ],
  }),

  langgraph: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/python/examples/agents/${agentId}/agent.py`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/typescript/examples/src/agents/${agentId}/agent.ts`,
          ),
        ],
      }),
      {},
    );
  },
  "langgraph-typescript": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/python/examples/agents/${agentId}/agent.py`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/typescript/examples/src/agents/${agentId}/agent.ts`,
          ),
        ],
      }),
      {},
    );
  },
  "langgraph-fastapi": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langgraph/python/examples/agents/${agentId}/agent.py`,
          ),
        ],
      }),
      {},
    );
  },
  "spring-ai": () => ({}),
  ag2: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/ag2/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  agno: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/agno/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "llama-index": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/llama-index/python/examples/server/routers/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  crewai: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/crew-ai/python/examples/agents/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "crewai-conversational-flows": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            "/crew-ai/python/examples/agents/conversational.py",
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/crew-ai/python/examples/agents/${
              agentId === "v1_agentic_chat"
                ? "agentic_chat"
                : agentId === "interrupt"
                  ? "interrupt_flow"
                  : agentId
            }.py`,
          ),
        ],
      }),
      {},
    );
  },
  "adk-middleware": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/adk-middleware/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "aws-strands": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/aws-strands/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "aws-strands-typescript": (agentKeys: string[]) => {
    // TS example filenames use hyphens — map underscore keys (agentic_chat)
    // to hyphenated filenames (agentic-chat.ts).
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/aws-strands/typescript/examples/server/api/${agentId.replace(/_/g, "-")}.ts`,
          ),
        ],
      }),
      {},
    );
  },
  "microsoft-agent-framework-python": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/python/examples/agents/dojo.py`,
          ),
        ],
      }),
      {},
    );
  },
  "microsoft-agent-framework-dotnet": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/ChatClientAgentFactory.cs`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/SharedStateAgent.cs`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/microsoft-agent-framework/dotnet/examples/AGUIDojoServer/Program.cs`,
          ),
        ],
      }),
      {},
    );
  },
  "ag-ui-dotnet": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            sdksFolderPath,
            `/dotnet/samples/AGUIClientServer/AGUIDojoServer/Program.cs`,
          ),
          path.join(
            __dirname,
            sdksFolderPath,
            `/dotnet/samples/AGUIClientServer/AGUIDojoServer/ChatClientAgentFactory.cs`,
          ),
        ],
      }),
      {},
    );
  },
  "agent-spec-langgraph": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/agent-spec/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "agent-spec-wayflow": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/agent-spec/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  // A2A integrations use runtime-configured agents without per-feature source files
  "a2a-basic": () => ({}),
  a2a: () => ({}),
  // Built-in agent with A2UI middleware - uses dedicated API route
  builtin: () => ({}),
  "claude-agent-sdk-python": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-agent-sdk/python/examples/agents/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
  "claude-agent-sdk-typescript": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-agent-sdk/typescript/examples/${agentId}.ts`,
          ),
        ],
      }),
      {},
    );
  },
  // claude-managed-agents serves every feature from one server per language,
  // driven by the shared agent specs.
  "claude-managed-agents-dotnet": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/dotnet/examples/AGUIDojoServer/AgentSpecs.cs`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/dotnet/examples/AGUIDojoServer/ExampleAgents.cs`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/dotnet/examples/AGUIDojoServer/Program.cs`,
          ),
        ],
      }),
      {},
    );
  },
  "claude-managed-agents-python": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/python/examples/agents.py`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/python/examples/server.py`,
          ),
        ],
      }),
      {},
    );
  },
  "claude-managed-agents-typescript": (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/typescript/examples/agents.ts`,
          ),
          path.join(
            __dirname,
            integrationsFolderPath,
            `/claude-managed-agents/typescript/examples/server.ts`,
          ),
        ],
      }),
      {},
    );
  },
  // watsonx uses a single TS agent for all features — no per-feature server files
  watsonx: () => ({
    agentic_chat: [
      path.join(
        __dirname,
        integrationsFolderPath,
        `/watsonx/typescript/src/index.ts`,
      ),
    ],
  }),
  langroid: (agentKeys: string[]) => {
    return agentKeys.reduce(
      (acc, agentId) => ({
        ...acc,
        [agentId]: [
          path.join(
            __dirname,
            integrationsFolderPath,
            `/langroid/python/examples/server/api/${agentId}.py`,
          ),
        ],
      }),
      {},
    );
  },
};

async function runGenerateContent() {
  const result = {};
  for (const agentConfig of agentConfigs) {
    // Use the parsed agent keys instead of executing the agents function
    const agentsPerFeatures = agentConfig.agentKeys;

    const agentFilePaths = agentFilesMapper[agentConfig.id]?.(
      agentConfig.agentKeys,
    );

    console.log(agentConfig.id, agentFilePaths);
    if (!agentFilePaths) {
      continue;
    }

    // If agentsPerFeatures is empty but we have agentFilePaths, use the keys from agentFilePaths
    // This handles cases like Mastra where agents are dynamically discovered
    const featureIds =
      agentsPerFeatures.length > 0
        ? agentsPerFeatures
        : Object.keys(agentFilePaths);

    // Per feature, assign all the frontend files like page.tsx as well as all agent files
    for (const featureId of featureIds) {
      const agentFilePathsForFeature = agentFilePaths[featureId] ?? [];
      const allFiles = [
        // Get all frontend files for the feature
        ...(await getFeatureFrontendFiles(featureId)),
        // Get the agent (python/TS) file
        ...(await Promise.all(
          agentFilePathsForFeature.map(async (f) => await getFile(f)),
        )),
      ];
      // Filter out empty objects (files that weren't found)
      // @ts-expect-error -- redundant error about indexing of a new object.
      result[`${agentConfig.id}::${featureId}`] = allFiles.filter(
        (file) => Object.keys(file).length > 0,
      );
    }
  }

  return result;
}

/**
 * Validates that all integration IDs in menuIntegrations have corresponding
 * entries in agentFilesMapper. Returns true if valid, false otherwise.
 */
function validateAgentFilesMapper(): boolean {
  const menuIntegrationIds = menuIntegrations.map(
    (integration) => integration.id,
  );
  const mapperKeys = new Set(Object.keys(agentFilesMapper));

  const missingEntries = menuIntegrationIds.filter((id) => !mapperKeys.has(id));

  if (missingEntries.length > 0) {
    console.error(
      "❌ Missing agentFilesMapper entries for the following integration IDs:",
    );
    console.error("");
    for (const id of missingEntries) {
      console.error(`   - ${id}`);
    }
    console.error("");
    console.error("Please add entries for these IDs in:");
    console.error(
      "   apps/dojo/scripts/generate-content-json.ts (agentFilesMapper object)",
    );
    console.error("");
    console.error(
      "Then run `(p)npm run generate-content-json` in the apps/dojo folder.",
    );
    console.error("");
    return false;
  }

  return true;
}

/**
 * Validates that all feature folders have a README.mdx file.
 * Returns true if valid, false otherwise.
 */
function validateFeatureReadmes(): boolean {
  // Get all unique features across all integrations
  const allFeatures = new Set<string>();
  for (const integration of menuIntegrations) {
    for (const feature of integration.features) {
      allFeatures.add(feature);
    }
  }

  const missingReadmes: Array<{ feature: string; integrations: string[] }> = [];

  for (const feature of allFeatures) {
    const readmePath = path.join(resolveFeatureDir(feature), "README.mdx");

    if (!fs.existsSync(readmePath)) {
      // Find which integrations use this feature
      const integrationsUsingFeature = menuIntegrations
        .filter((i) => (i.features as string[]).includes(feature))
        .map((i) => i.id);

      missingReadmes.push({
        feature,
        integrations: integrationsUsingFeature,
      });
    }
  }

  if (missingReadmes.length > 0) {
    console.error("❌ Missing README.mdx files for the following features:");
    console.error("");
    for (const { feature, integrations } of missingReadmes) {
      console.error(`   - ${feature}`);
      console.error(`     Used by: ${integrations.join(", ")}`);
      console.error(
        `     Missing: ${path.relative(path.join(__dirname, ".."), path.join(resolveFeatureDir(feature), "README.mdx"))}`,
      );
    }
    console.error("");
    console.error("Please create README.mdx files for these features.");
    console.error(
      "See apps/dojo/src/app/[integrationId]/feature/agentic_chat/README.mdx for an example.",
    );
    console.error("");
    return false;
  }

  return true;
}

(async () => {
  // Validate that all menuIntegrations have agentFilesMapper entries
  if (!validateAgentFilesMapper()) {
    process.exit(1);
  }

  // Validate that all features have README.mdx files
  if (!validateFeatureReadmes()) {
    process.exit(1);
  }

  const result = await runGenerateContent();
  fs.writeFileSync(
    path.join(__dirname, "../src/files.json"),
    JSON.stringify(result, null, 2),
  );

  console.log("Successfully generated src/files.json");
})();
