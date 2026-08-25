# ag-ui-dotnet

Agent skills for building applications with the [AG-UI .NET SDK](https://docs.ag-ui.com).

The plugin adds task-focused skills that an AI coding agent loads on demand:

| Skill | What it helps you do |
| --- | --- |
| `agui-dotnet-streaming-chat` | Bootstrap a client + server and stream a multi-turn conversation; stateless vs hosted agents |
| `agui-dotnet-server-tools` | Expose backend C# functions the agent calls on the server |
| `agui-dotnet-client-tools` | Expose client-side functions the agent calls in the app |
| `agui-dotnet-human-in-the-loop` | Gate a tool behind approval, or pause for user input, then resume |
| `agui-dotnet-shared-state` | Sync structured state between agent and client (snapshots/deltas) |
| `agui-dotnet-multimodal` | Send images and other binary content to a multimodal model |
| `agui-dotnet-reasoning` | Surface a reasoning model's thinking separately from its answer |
| `agui-dotnet-protobuf` | Use the protobuf wire transport instead of SSE |
| `agui-dotnet-troubleshoot` | Diagnose common AG-UI .NET problems |

## Install

This plugin ships in the `ag-ui` marketplace at the root of the repository.

### GitHub Copilot CLI

```shell
copilot plugin marketplace add ag-ui-protocol/ag-ui
copilot plugin install ag-ui-dotnet@ag-ui
```

### Claude Code

```shell
/plugin marketplace add ag-ui-protocol/ag-ui
/plugin install ag-ui-dotnet@ag-ui
```

To install directly from a local checkout, point either tool at this directory instead (for example `copilot plugin install ./sdks/dotnet/plugins/ag-ui-dotnet`).
