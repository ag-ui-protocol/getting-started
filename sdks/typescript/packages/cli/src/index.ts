#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import { spawn } from "child_process";
import { buildCopilotKitCreateArgs } from "./build-args";
import fs from "fs";
import path from "path";
import { downloadTemplate } from "giget";

const program = new Command();

// Dark purple color
const PURPLE = "\x1b[35m";
const RESET = "\x1b[0m";

function displayBanner() {
  const banner = `
${PURPLE}   █████╗  ██████╗       ██╗   ██╗ ██╗
  ██╔══██╗██╔════╝       ██║   ██║ ██║
  ███████║██║  ███╗█████╗██║   ██║ ██║
  ██╔══██║██║   ██║╚════╝██║   ██║ ██║
  ██║  ██║╚██████╔╝      ╚██████╔╝ ██║
  ╚═╝  ╚═╝ ╚═════╝        ╚═════╝  ╚═╝
${RESET}
  Agent User Interactivity Protocol
`;
  console.log(banner);
}

const description = `
Quickly scaffold AG-UI enabled applications for your favorite agent frameworks.
`;

async function createProject() {
  displayBanner();

  console.log("\n~ Let's get started building an AG-UI powered user interactive agent ~");
  console.log("  Read more about AG-UI at https://ag-ui.com\n");

  const options = program.opts();
  const isFrameworkDefined = [
    "langgraphPy",
    "langgraphJs",
    "crewaiFlows",
    "mastra",
    "ag2",
    "llamaindex",
    "pydanticAi",
    "agno",
    "adk",
  ].some((flag) => options[flag]);

  if (isFrameworkDefined) {
    await handleCopilotKitNextJs();
    return;
  } else {
    console.log("");
    console.log("To build an AG-UI app, you need to select a client.");
    console.log("");
  }

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "client",
      message: "What client do you want to use?",
      choices: [
        "CopilotKit/Next.js",
        "CLI client",
        new inquirer.Separator(" Other clients coming soon (SMS, Whatsapp, Slack ...)"),
      ],
    },
  ]);

  switch (answers.client) {
    case "CopilotKit/Next.js":
      await handleCopilotKitNextJs();
      break;
    case "CLI client":
      await handleCliClient();
      break;
    default:
      break;
  }
}

async function handleCopilotKitNextJs() {
  const options = program.opts();

  const projectName = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "What would you like to name your project?",
      default: "my-ag-ui-app",
      validate: (input) => {
        if (!input.trim()) {
          return "Project name cannot be empty";
        }
        if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
          return "Project name can only contain letters, numbers, hyphens, and underscores";
        }
        return true;
      },
    },
  ]);

  const copilotkit = spawn("npx", buildCopilotKitCreateArgs(options, projectName.name), {
    stdio: "inherit",
    shell: true,
  });

  copilotkit.on("close", (code) => {
    if (code !== 0) {
      console.log("\n❌ Project creation failed.");
    }
  });
}

async function handleCliClient() {
  console.log("🔧 Setting up CLI client...\n");

  // Get current package versions from the monorepo
  console.log("🔍 Reading current package versions...");
  const versions = await getCurrentPackageVersions();
  console.log(`📋 Found versions: ${Object.keys(versions).length} packages`);
  Object.entries(versions).forEach(([name, version]) => {
    console.log(`  - ${name}: ${version}`);
  });
  console.log("");

  const projectName = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "What would you like to name your CLI project?",
      default: "my-ag-ui-cli-app",
      validate: (input) => {
        if (!input.trim()) {
          return "Project name cannot be empty";
        }
        if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
          return "Project name can only contain letters, numbers, hyphens, and underscores";
        }
        return true;
      },
    },
  ]);

  try {
    console.log(`📥 Downloading CLI client template: ${projectName.name}\n`);

    await downloadTemplate("gh:ag-ui-protocol/ag-ui/apps/client-cli-example", {
      dir: projectName.name,
      install: false,
    });

    console.log("✅ CLI client template downloaded successfully!");

    // Update workspace dependencies with actual versions
    console.log("\n🔄 Updating workspace dependencies...");
    await updateWorkspaceDependencies(projectName.name, versions);

    console.log(`\n📁 Project created in: ${projectName.name}`);
    console.log("\n🚀 Next steps:");
    console.log("   export OPENAI_API_KEY='your-openai-api-key'");
    console.log(`   cd ${projectName.name}`);
    console.log("   npm install");
    console.log("   npm run dev");
    console.log("\n💡 Check the README.md for more information on how to use your CLI client!");
  } catch (error) {
    console.log("❌ Failed to download CLI client template:", error);
    process.exit(1);
  }
}

// Metadata
program.name("create-ag-ui-app").description(description).version("0.0.36");

// Add framework flags
program
  .option("--langgraph-py", "Use the LangGraph framework with Python")
  .option("--langgraph-js", "Use the LangGraph framework with JavaScript")
  .option("--crewai-flows", "Use the CrewAI framework with Flows")
  .option("--mastra", "Use the Mastra framework")
  .option("--pydantic-ai", "Use the Pydantic AI framework")
  .option("--llamaindex", "Use the LlamaIndex framework")
  .option("--agno", "Use the Agno framework")
  .option("--ag2", "Use the AG2 framework")
  .option("--adk", "Use the ADK framework");

program.action(async () => {
  await createProject();
});

program.parse();

// Utility functions

// Helper function to get package versions from npmjs
async function getCurrentPackageVersions(): Promise<{ [key: string]: string }> {
  const packages = ["@ag-ui/client", "@ag-ui/core", "@ag-ui/mastra"];
  const versions: { [key: string]: string } = {};

  for (const packageName of packages) {
    try {
      // Fetch package info from npm registry
      const response = await fetch(`https://registry.npmjs.org/${packageName}`);
      if (response.ok) {
        const packageInfo = await response.json();
        versions[packageName] = packageInfo["dist-tags"]?.latest || "latest";
        console.log(`  ✓ ${packageName}: ${versions[packageName]}`);
      } else {
        console.log(`  ⚠️  Could not fetch version for ${packageName}`);
        // Fallback to latest
        versions[packageName] = "latest";
      }
    } catch (error) {
      console.log(`  ⚠️  Error fetching ${packageName}: ${error}`);
      // Fallback to latest
      versions[packageName] = "latest";
    }
  }

  return versions;
}

// Function to update workspace dependencies in downloaded project
async function updateWorkspaceDependencies(
  projectPath: string,
  versions: { [key: string]: string },
) {
  const packageJsonPath = path.join(projectPath, "package.json");

  try {
    if (!fs.existsSync(packageJsonPath)) {
      console.log("⚠️  No package.json found in downloaded project");
      return;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    let updated = false;

    // Update workspace dependencies with actual versions
    if (packageJson.dependencies) {
      for (const [depName, depVersion] of Object.entries(packageJson.dependencies)) {
        if (
          typeof depVersion === "string" &&
          depVersion.startsWith("workspace:") &&
          versions[depName]
        ) {
          packageJson.dependencies[depName] = `^${versions[depName]}`;
          updated = true;
          console.log(`  📦 Updated ${depName}: workspace:* → ^${versions[depName]}`);
        }
      }
    }

    if (updated) {
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
      console.log("✅ Package.json updated with actual package versions!");
    } else {
      console.log("📄 No workspace dependencies found to update");
    }
  } catch (error) {
    console.log(`❌ Error updating package.json: ${error}`);
  }
}
