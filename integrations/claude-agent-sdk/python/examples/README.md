# Claude Agent SDK Examples

Examples for AG-UI Dojo.

## Running the Server

```bash
# Install dependencies
cd ../
pip install -e .

# Start server
cd examples
ANTHROPIC_API_KEY=sk-ant-xxx python server.py
```

Server runs on **http://localhost:8019**

## Testing with Dojo

```bash
# In another terminal
cd /path/to/ag-ui/apps/dojo
pnpm dev
```

Open http://localhost:3000 and select "Claude Agent SDK"

## Features

### Agentic Chat
Basic conversation with Claude's built-in tools enabled.

**Try:** "Create a Python hello world script"

### Backend Tool Rendering
Claude with custom `get_weather` tool - demonstrates backend tool calling.

**Try:** "What's the weather in San Francisco?"
