# AG-UI .NET SDK

AG-UI (Agent User Interaction Protocol) standardizes streaming communication between AI agents and user interfaces. The .NET SDK provides protocol types, wire formatters, protobuf support, an HTTP client, and a framework-agnostic server adapter built around `Microsoft.Extensions.AI`.

## Packages

- `AGUI.Abstractions` — protocol events, messages, tools, capabilities, and JSON serialization.
- `AGUI.Formatting` — event stream formatter abstractions and Server-Sent Events support.
- `AGUI.Protobuf` — protobuf codec and binary event stream formatting.
- `AGUI.Client` — AG-UI HTTP client and `IChatClient` integration.
- `AGUI.Server` — server-side adapter from `ChatResponseUpdate` streams to AG-UI events.

For documentation, samples, and source, see https://github.com/ag-ui-protocol/ag-ui.
