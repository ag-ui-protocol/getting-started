# tRPC-Agent-Go AG-UI Dojo Server

This directory contains a tRPC-Agent-Go server that demonstrates the AG-UI
features available in the Dojo. Each feature is implemented in its own Go
package, while `main.go` mounts all examples on a single server.

## Prerequisites

- Go 1.24.4
- An OpenAI-compatible endpoint that provides `gpt-4o` and
  `deepseek-v4-pro`

## Quick start

```bash
export OPENAI_API_KEY="your-api-key"
# Optional when using an OpenAI-compatible provider:
export OPENAI_BASE_URL="https://your-provider.example/v1"

go run .
```

The server listens on `http://localhost:8027` by default.

## Available routes

| Feature                            | Endpoint                         |
| ---------------------------------- | -------------------------------- |
| Agentic chat                       | `/agentic_chat/agui`             |
| Agentic chat with reasoning        | `/agentic_chat_reasoning/agui`   |
| Agentic chat with multimodal input | `/agentic_chat_multimodal/agui`  |
| Agentic generative UI              | `/agentic_generative_ui/agui`    |
| Backend tool rendering             | `/backend_tool_rendering/agui`   |
| Human in the loop                  | `/human_in_the_loop/agui`        |
| Predictive state updates           | `/predictive_state_updates/agui` |
| Shared state                       | `/shared_state/agui`             |
| Tool-based generative UI           | `/tool_based_generative_ui/agui` |

The Dojo's `v1_agentic_chat` page also uses `/agentic_chat/agui`.

## Configuration

| Variable          | Default        | Description                                         |
| ----------------- | -------------- | --------------------------------------------------- |
| `PORT`            | `8027`         | Port on which the server listens                    |
| `OPENAI_API_KEY`  | empty          | API key read by the underlying OpenAI SDK           |
| `OPENAI_BASE_URL` | OpenAI default | Optional OpenAI-compatible base URL read by the SDK |

When run through the Dojo E2E scripts, the OpenAI SDK environment is
automatically configured to use the local LLMock server.
