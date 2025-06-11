# AG-UI Dify Integration

This package provides integration between AG-UI and Dify, allowing you to use Dify's AI agents with AG-UI's frontend components.

## Installation

```bash
pnpm add @ag-ui/dify
```

## Usage

```typescript
import { DifyAgent } from "@ag-ui/dify";

// Create a Dify agent
const agent = new DifyAgent({
  apiKey: "your-dify-api-key",
  baseUrl: "https://api.dify.ai/v1", // optional
});

// Use the agent with AG-UI components
```

## Features

- Seamless integration with AG-UI's frontend components
- Support for streaming responses
- Tool calling support
- Message format conversion between AG-UI and Dify

## API Reference

### DifyAgent

The main class for integrating Dify with AG-UI.

#### Constructor

```typescript
constructor(config: DifyClientConfig)
```

Parameters:
- `config`: Configuration object
  - `apiKey`: Your Dify API key
  - `baseUrl`: (optional) Dify API base URL, defaults to "https://api.dify.ai/v1"

#### Methods

- `stream(input: RunAgentInput)`: Streams the agent's response
  - Returns: AsyncGenerator of AG-UI events

## License

MIT 