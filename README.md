
  
[![AG-UI Workshop – June 5](https://img.shields.io/badge/AG--UI%20Workshop%20%E2%80%94%20-blue?style=flat-square)](https://go.copilotkit.ai/ag-ui-build-an-agent-canvas)
![Discord](https://img.shields.io/discord/1379082175625953370?logo=discord&logoColor=%23FFFFFF&label=Discord&color=%236963ff)
[![Quickstart](https://img.shields.io/badge/Quickstart%20%E2%80%94-blue?style=flat-square)](https://go.copilotkit.ai/ag-ui-working-group-3)





# <img src="https://github.com/user-attachments/assets/ebc0dd08-8732-4519-9b6c-452ce54d8058" alt="ag-ui Logo" height="42px" /> AG-UI: The Agent-User Interaction Protocol

AG-UI is an open, lightweight, event-based protocol that standardizes **how AI agents connect to front-end applications**.

➡️ See demos of AG-UI-enabled applications [here](https://github.com/ag-ui-protocol/ag-ui?tab=readme-ov-file#ag-ui-compatible-agent-frameworks)

<img src="https://github.com/user-attachments/assets/215227a5-9698-4d97-a46e-8904b95bfa08" alt="ag-ui Logo" style="max-width: 100px; height: auto;" />

# ➡️ Learn more (AG-UI Specification)

<details>
  <summary><strong>Click to expand</strong></summary>

  AG-UI is an open, lightweight, event-based protocol for agent-human interaction, designed for simplicity & flexibility:

  - During agent executions, agent backends **emit events _compatible_ with one of AG-UI's 16 standard event types**
  - Agent backends can **accept one of a few simple AG-UI compatible inputs** as arguments

  **AG-UI includes a flexible middleware layer** that ensures compatibility across diverse environments:

  - Works with **any event transport** (SSE, WebSockets, webhooks, etc.)
  - Allows for **loose event format matching**, enabling broad agent and app interoperability

  It also ships with a **reference HTTP implementation** and **default connector** to help teams get started fast.

  [Learn more at docs.ag-ui.com](https://ag-ui.com)

</details>

# ➡️ Why AG-UI?

<details>
  <summary><strong>Click to expand</strong></summary>

  AG-UI was developed based on real-world requirements and practical experience building in-app agent interactions.

  It was shaped through:

  - Working with users in the CopilotKit community to understand the needs of agent-based interactions in applications  
  - Collaborating closely with leading agent frameworks (LangGraph, Mastra, CrewAI, AG2, etc.)  
  - Extracting common infrastructure patterns that emerged across varied frameworks into a standardized, open protocol

  This practical approach has helped ensure that AG-UI is both flexible and immediately applicable in real-world use cases.

</details>

# ➡️ Build AG-UI-Powered Applications

### 🧭 Get Started with One Command: 
`npx-create-ag-ui-app`

### 🌐 Check out the quickstart: 
[Quickstart]()

Play with this hello-world app here:
https://agui-demo.vercel.app/

Video:

https://github.com/user-attachments/assets/18c03330-1ebc-4863-b2b8-cc6c3a4c7bae

## Select Your Language

- [TypeScript](https://github.com/ag-ui-protocol/ag-ui/tree/main/typescript-sdk)
- [Python](https://github.com/ag-ui-protocol/ag-ui/tree/main/python-sdk)

## AG-UI Compatible Agent Frameworks

AG-UI works with several popular agent frameworks and frontend solutions:

| Framework                                                          | Status                   | AG-UI Resources                                                              |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| [LangGraph](https://www.langchain.com/langgraph)                   | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-langgraph-land.vercel.app/) |
| [Mastra](https://mastra.ai/)                                       | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-mastra-land.vercel.app/)    |
| [CrewAI](https://crewai.com/)                                      | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-crew-land.vercel.app/)      |
| [AG2](https://ag2.ai/)                                             | ✅ Supported             | ➡️ [Live Demo / Getting Started Docs](https://v0-ag2-land.vercel.app/)       |
| [Agno](https://github.com/agno-agi/agno)                           | ✅ Supported             | -                                               |
| [LlamaIndex](https://www.llamaindex.ai)                            | ✅ Supported             | –                                                                            |
| [Dify](https://dify.ai/)                                           | - In Progress             | –                                                                            |
| [OpenAI Agent SDK](https://openai.github.io/openai-agents-python/) | 💡 Open to Contributions | –                                                                            |
| [Google ADK](https://google.github.io/adk-docs/get-started/)       | 💡 Open to Contributions | –                                                                            |
| [Vercel AI SDK](https://github.com/vercel/ai)                      | 💡 Open to Contributions | –                                                                            |
| [AWS Bedrock Agents](https://aws.amazon.com/bedrock/agents/)       | 💡 Open to Contributions | –                                                                            |
| [Cloudflare Agents](https://developers.cloudflare.com/agents/)     | 💡 Open to Contributions | –                                                                            |
| [Pydantic AI ](https://ai.pydantic.dev/)                           | 💡 Open to Contributions | –                                                                            |
| [Strands Agents SDK](https://github.com/strands-agents/sdk-python) | 💡 Open to Contributions | –                                                                            |

| Language SDK                                                      | Status                | AG-UI Resources                                                                 |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| [.NET]()                                                           | 🛠️ In Progress               | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/38)                 |
| [Nim]()                                                            | 🛠️ In Progress               | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/29)                 |

| Clients                                                 | Status                | AG-UI Resources                                                                 |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| [CopilotKit](https://copilotkit.ai)                                | ✅ Supported                | ➡️ [PR](https://github.com/ag-ui-protocol/ag-ui/pull/38)                 


## Features

AG-UI-compatible agents **securely** and **efficiently** support:

- 💬 Agentic chat with real-time streaming
- 🔄 Bi-directional state sync (in and out of chat)
- 🧩 Generative UI and structured messages (with delta streaming)
- 🧠 Realtime context enrichment
- 🛠️ Frontend tool use (tool calls)
- 🧑‍💻 Human-in-the-loop and human-on-the-loop collaboration

And more. [Learn more at ag-ui.com](https://ag-ui.com)

## AG-UI Showcase: The AG-UI Dojo (Building-Blocks Viewer)

The [ag-ui dojo](https://feature-viewer-langgraph.vercel.app/) showcases many of the building blocks that ag-ui supports.

The building blocks are designed to be simple and focused -- between 50-200 lines of code.

https://github.com/user-attachments/assets/a67d3d54-36b2-4c7a-ac69-a0ca01365d5b

## Client Libraries

AG-UI provides ready-to-use client libraries for building connected experiences:

- **React client** via [CopilotKit](https://docs.copilotkit.ai/)
- Messaging clients (WhatsApp, WeChat, RCS) — WIP in collaboration with AWS SNS

# ➡️ Contribute to AG-UI

Learn how to contribute to AG-UI: [AG-UI Contribution Guide](https://go.copilotkit.ai/agui-contribute)

Book time with Markus Ecker, the creator of AG-UI: https://calendly.com/markus-copilotkit/ag-ui

Join the Discord: https://discord.gg/Jd3FzfdJa8

## Community

### Upcoming Events

- **[AG-UI: Workshop](https://go.copilotkit.ai/ag-ui-build-an-agent-canvas)**  
  📅 Friday, June 5, 9:00 AM PT  
  🔗 [Register now](https://go.copilotkit.ai/ag-ui-working-group-3)


## Contributing

We 💜 contributions! Whether you're fixing bugs, improving documentation, or building demos — your contributions make AG-UI better.
