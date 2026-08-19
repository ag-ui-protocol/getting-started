# AG-UI Go Example Server

This example is a Fiber v3 AG-UI server for local development and Dojo testing.
It replaces the older minimal `/agentic` example with a broader route surface
based on the Go Dojo server example.

## Run

Requires Go 1.25 or newer. Fiber v3.3.0 requires Go 1.25, so `go mod tidy`
updates this example module to `go 1.25.0`.

```bash
cd sdks/community/go/example/server
OPENAI_API_KEY=... go run ./cmd
```

The default server address is `http://127.0.0.1:8080`.

The server uses the reproducible `MODEL_PROVIDER=openai` path from
`github.com/cloudwego/eino-ext/components/model/openai`. Prototype-only provider
and tool dependencies from the standalone source were removed for this monorepo
example. The read-only `file_read` tool is implemented locally in
`internal/agent/tools.go`.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server bind host. |
| `PORT` | `8080` | Server port. |
| `MODEL_PROVIDER` | `openai` | Only `openai` is supported in this monorepo example. |
| `MODEL` | `gpt-4o` | Model passed to the OpenAI Eino provider. |
| `OPENAI_API_KEY` | unset | Required for model-backed routes and multimodal helper clients. |
| `AGENT_WORKSPACE` | process working directory | Read-only root for the `file_read` tool. Set it deliberately. |
| `AGENT_AUTO_APPROVE` | `false` | Bypass the approval interrupt path for `/agentic`. |
| `AGENT_MAX_ITERATIONS` | `8` | Model/tool loop iteration budget. |
| `CORS_ENABLED` | `true` | Permissive CORS for local UI development. |
| `AGENTIC_UI_PACE_MS` | `600` | Step delay for `/agentic_generative_ui`. |

## Routes

| Route | Notes |
| --- | --- |
| `GET /` | Health/config metadata and route list. |
| `POST /agentic` | Primary read-only agent loop. |
| `POST /agentic_chat` | Dojo frontend-tools chat route. |
| `POST /backend_tool_rendering` | Dojo route alias using the frontend-tools chat posture. |
| `POST /human_in_the_loop` | Approval route. `X-AG-Approval: off` or `?approval=off` disables the approval gate. |
| `POST /agentic_generative_ui` | Deterministic multi-step generative UI route. |
| `POST /tool_based_generative_ui` | Client-tool generative UI route. |
| `POST /shared_state` | Recipe shared-state route. |
| `POST /predictive_state_updates` | Document predictive state updates route. |
| `POST /agentic_chat_multimodal` | Multimodal-capable chat route using the OpenAI provider path. |
| `POST /image-gen` | OpenAI image generation helper. |
| `POST /vision` | OpenAI vision helper. |
| `POST /audio` | OpenAI audio transcription helper. |
| `POST /document` | OpenAI document analysis helper. |

All `POST` routes accept AG-UI `RunAgentInput` JSON unless noted by their
specific handler. SSE responses use the AG-UI event stream format.

## Dojo

Run this server separately and configure Dojo to point the relevant integration
runtime URL at `http://127.0.0.1:8080`. This server lives under the Go SDK
examples rather than an `integrations/.../examples` package, so it is not
automatically registered as a first-class Dojo integration by this change.

## Go Client

The Go example client default endpoint is aligned with this server:

```text
http://localhost:8080/agentic
```

Pass an explicit endpoint to the client if you run the server on a different
host or port.

## Verification

```bash
cd sdks/community/go/example/server
gofmt -w ./cmd ./internal
go mod tidy
go test ./...
go test ./... -run 'Test.*Route|Test.*App|Test.*SSE'
rg -n 'github.com/mattsp1290/ag-ui-go-server-example|/Users/punk1290/git|v0.0.0-00010101000000-000000000000' go.mod go.sum cmd internal
```

Credentialed model calls require `OPENAI_API_KEY`; integration tests that need
it skip when the variable is unset.
