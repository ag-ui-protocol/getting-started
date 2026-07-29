# Hermes

Implementation of the AG-UI protocol for [Hermes](https://nousresearch.com/) by Nous Research.

`@ag-ui/hermes` provides `HermesAgent`, a thin [`HttpAgent`](https://github.com/ag-ui-protocol/ag-ui) subclass that connects an AG-UI client to a Hermes agent exposed over the AG-UI HTTP/SSE protocol (via the Hermes AG-UI adapter).

## Installation

```shell
npm install @ag-ui/hermes
# or
pnpm add @ag-ui/hermes
# or
yarn add @ag-ui/hermes
```

## Usage

```ts
import { HermesAgent } from "@ag-ui/hermes";

const agent = new HermesAgent({
  url: "http://localhost:8000/",
});
```

`HermesAgent` behaves exactly like `HttpAgent` — it POSTs the AG-UI `RunAgentInput`
and consumes the streamed AG-UI event sequence — while pinning the AG-UI protocol
`maxVersion` the Hermes adapter supports.

## Server side

Point the agent's `url` at a running Hermes AG-UI adapter, which serves the AG-UI
run endpoint at `POST /`. The adapter bridges the Hermes agent to the AG-UI
protocol (translating `RunAgentInput` into Hermes turns and streaming
`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `REASONING_MESSAGE_*`, and `STATE_SNAPSHOT`
events back over SSE).
