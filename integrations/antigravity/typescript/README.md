# @ag-ui/antigravity

TypeScript client for [Google Antigravity](https://github.com/google-antigravity/antigravity-sdk-python)
agents exposed over the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui).

All translation happens on the Python side (`ag_ui_antigravity`), so this is a
thin `HttpAgent` plus capability discovery.

```bash
npm install @ag-ui/antigravity
```

```ts
import { AntigravityAgent } from "@ag-ui/antigravity";

const agent = new AntigravityAgent({ url: "http://localhost:8009/agentic_chat" });

const capabilities = await agent.getCapabilities();
// { tools: { supported: true, clientProvided: true },
//   humanInTheLoop: { supported: true, interrupts: true }, ... }
```

`getCapabilities()` fetches `<url>/capabilities` and validates the response
against `AgentCapabilitiesSchema`, throwing on a malformed payload. Override
`capabilitiesUrl()` or `capabilitiesRequestInit()` to customize the URL or auth.

See the [Python package](../python/README.md) for the server, the event
mapping, and the human-in-the-loop design.
