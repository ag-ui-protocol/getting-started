# tRPC-Agent-Go Integration for AG-UI

[tRPC-Agent-Go](https://github.com/trpc-group/trpc-agent-go) connects Go agents
to AG-UI clients through an AG-UI server adapter.

## Resources

- [AG-UI server package](https://github.com/trpc-group/trpc-agent-go/tree/main/server/agui)
- [Integration guide](https://trpc-group.github.io/trpc-agent-go/agui/)
- [tRPC-Agent-Go examples](https://github.com/trpc-group/trpc-agent-go/tree/main/examples/agui)

## Dojo examples

The [`go/examples`](go/examples) directory contains a server that demonstrates
the integration in the AG-UI Dojo. The Dojo connects to the server with the
standard `HttpAgent` from `@ag-ui/client`.

## Quick start

```bash
cd go/examples
export OPENAI_API_KEY="your-api-key"
# Optional when using an OpenAI-compatible provider:
export OPENAI_BASE_URL="https://your-provider.example/v1"

go run .
```

The server listens on `http://localhost:8027` by default. See the
[examples README](go/examples/README.md) for prerequisites, available routes,
and configuration options.
