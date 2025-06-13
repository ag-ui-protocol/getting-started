# <img src="https://github.com/user-attachments/assets/ebc0dd08-8732-4519-9b6c-452ce54d8058" alt="ag-ui Logo" height="42px" /> AG-UI: The Agent-User Interaction Protocol

![0613](https://github.com/user-attachments/assets/bec3bc01-d8f2-4667-885e-028cbcbc8439)


AG-UI is a lightweight, event-based protocol that standardizes how AI agents connect to front-end applications. Built for simplicity and flexibility, it enables seamless integration between your AI agents and user interfaces.

[![AG-UI Workshop – June 5](https://img.shields.io/badge/AG--UI%20Workshop%20%E2%80%94June%2019-blue?style=flat-square)](https://go.copilotkit.ai/ag-ui-build-an-agent-canvas)
![Discord](https://img.shields.io/discord/1379082175625953370?logo=discord&logoColor=%23FFFFFF&label=Discord&color=%236963ff)



## Quick Start

Choose your path:

### 🚀 Building AG-UI Powered Applications

Create a new AG-UI application in seconds:

```bash
npx create-ag-ui-app my-agent-app
```

[View Documentation](https://ag-ui.com) · [Join Discord](https://discord.gg/Jd3FzfdJa8) · [Book a Call](https://calendly.com/markus-copilotkit/ag-ui)

### 🔌 Building AG-UI Integrations

```bash
# Clone the repository
git clone https://github.com/ag-ui-protocol/ag-ui.git

# Install dependencies
cd ag-ui
npm install
```

[Integration Guide](https://ag-ui.com/integrations)

## Why AG-UI?

AG-UI was developed through real-world experience building in-app agent interactions. It provides:

- **Standardized Event Types**: 16 standard event types for consistent agent communication
- **Flexible Middleware**: Works with any event transport (SSE, WebSockets, webhooks)
- **Broad Compatibility**: Seamlessly integrates with popular agent frameworks
- **Production Ready**: Includes reference HTTP implementation and default connector

## Features

- 💬 Real-time agentic chat with streaming
- 🔄 Bi-directional state synchronization
- 🧩 Generative UI and structured messages
- 🧠 Real-time context enrichment
- 🛠️ Frontend tool integration
- 🧑‍💻 Human-in-the-loop collaboration

## Framework Support

AG-UI works with leading agent frameworks:

| Framework | Status | Resources |
|-----------|--------|-----------|
| LangGraph | ✅ Supported | [Demo](https://v0-langgraph-land.vercel.app/) |
| Mastra | ✅ Supported | [Demo](https://v0-mastra-land.vercel.app/) |
| CrewAI | ✅ Supported | [Demo](https://v0-crew-land.vercel.app/) |
| AG2 | ✅ Supported | [Demo](https://v0-ag2-land.vercel.app/) |

[View all supported frameworks →](https://ag-ui.com/frameworks)

## Getting Started

### For Application Builders

1. **Create Your App**
   ```bash
   npx create-ag-ui-app my-agent-app
   ```
   This sets up a complete AG-UI application with:
   - TypeScript/React frontend
   - Agent backend
   - Development environment
   - Example components

2. **Choose Your SDK**
   - [TypeScript SDK](https://github.com/ag-ui-protocol/ag-ui/tree/main/typescript-sdk)
   - [Python SDK](https://github.com/ag-ui-protocol/ag-ui/tree/main/python-sdk)

3. **Explore Examples**
   - [AG-UI Dojo](https://feature-viewer-langgraph.vercel.app/) - Building blocks showcase
   - [Hello World App](https://agui-demo.vercel.app/) - Basic implementation

### For Framework Integrators

1. **Understand the Architecture**
   - Server-side: Agent implementation and event processing
   - Middleware: Event transport and protocol handling
   - Client-side: UI integration and state management

2. **Integration Process**
   - Create a new directory in `/integrations` with your framework name
   - Follow the [Integration Guide](https://ag-ui.com/integrations)
   - For work in progress, use the `-wip` suffix (e.g., `OpenAIAgentsSDK-wip`)

3. **Testing**
   - Use the [AG-UI Dojo](https://feature-viewer-langgraph.vercel.app/) for validation
   - Implement all core capabilities
   - Verify event sequence and data format

## Live Demo

Try our interactive demo to see AG-UI in action:

[Launch Demo](https://agui-demo.vercel.app/)

## Contributing

We welcome contributions! Here's how to get involved:

1. **Choose Your Path**
   - Building applications with AG-UI
   - Contributing framework integrations
   - Improving documentation
   - Adding new features

2. **Development Setup**
   ```bash
   git clone https://github.com/ag-ui-protocol/ag-ui.git
   cd ag-ui
   npm install
   ```

3. **Integration Guidelines**
   - Place new integrations in `/integrations`
   - Use `-wip` suffix for work in progress
   - Follow the [Integration Guide](https://ag-ui.com/integrations)
   - Add tests and documentation

4. **Community**
   - [Discord](https://discord.gg/Jd3FzfdJa8)
   - [Upcoming Workshop](https://go.copilotkit.ai/ag-ui-working-group-3)
   - [Book a Call](https://calendly.com/markus-copilotkit/ag-ui)

[View Contribution Guide](https://go.copilotkit.ai/agui-contribute)

## License

AG-UI is open source and available under the MIT License.
