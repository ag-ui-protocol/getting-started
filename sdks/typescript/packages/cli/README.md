# create-ag-ui-app

CLI tool for scaffolding **Agent-User Interaction (AG-UI) Protocol** applications.

`create-ag-ui-app` provides an interactive setup wizard to quickly bootstrap AG-UI projects with your preferred client framework and agent backend.

Choose from CopilotKit/Next.js for web apps or CLI clients for terminal-based interactions.

## Usage

```bash
npx create-ag-ui-app@latest
pnpx create-ag-ui-app@latest
bunx create-ag-ui-app@latest
```

## Features

- 🎯 **Interactive setup** – Guided prompts for client and framework selection
- 🌐 **Multiple clients** – CopilotKit/Next.js web apps and CLI clients
- 🔧 **Framework integration** – Built-in support for LangGraph, CrewAI, Mastra, Agno, LlamaIndex, and more
- 📦 **Zero config** – Automatically sets up dependencies and project structure
- ⚡ **Quick start** – Get from idea to running app in minutes

## Quick example

```bash
# Interactive setup
npx create-ag-ui-app@latest

# With framework flags
npx create-ag-ui-app@latest --langgraph-py
npx create-ag-ui-app@latest --mastra
npx create-ag-ui-app@latest --adk-js

# See all options
npx create-ag-ui-app@latest --help
```

`--adk-js` downloads the native Google ADK JavaScript starter. The existing
`--adk` option remains the Python ADK scaffold.

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/events`](https://docs.ag-ui.com/concepts/events)
- Google ADK JavaScript quickstart: [docs.ag-ui.com/integrations/google-adk-js](https://docs.ag-ui.com/integrations/google-adk-js)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://github.com/ag-ui-protocol/ag-ui/blob/main/CONTRIBUTING.md) first.

## License

MIT © 2025 AG-UI Protocol Contributors
