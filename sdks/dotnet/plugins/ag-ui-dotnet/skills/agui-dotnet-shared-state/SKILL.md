---
name: agui-dotnet-shared-state
description: >
  Share structured, evolving state between an AG-UI agent and its client with the AG-UI .NET SDK — the client seeds state on the request, the server reads it, mutates it, and streams the updated state back as snapshots or deltas alongside the chat. USE FOR: sending initial/working state from the client via ChatOptions.RawRepresentationFactory -> RunAgentInput.State; reading inbound state on the server with ChatOptions.TryGetRunAgentInput and RunAgentInput.State; emitting a full state object as a StateSnapshotEvent (or incremental JSON-Patch changes as a StateDeltaEvent) from a DelegatingChatClient via ChatResponseUpdate.RawRepresentation; reading state back on the client from update.RawRepresentation as StateSnapshotEvent. DO NOT USE FOR: passing one-off tool arguments (use agui-dotnet-server-tools); rendering UI components from tool calls (use agui-dotnet-generative-ui); plain chat (use agui-dotnet-streaming-chat); approvals/interrupts, multimodal, or protobuf.
---

# AG-UI .NET — shared state

Goal: keep a structured object (a form, a document, a plan, a recipe) in sync between the client and the agent — the client provides the current state, the agent updates it, and the new state streams back next to the assistant's text.

State travels on the wire inside `RunAgentInput.State` (inbound) and as `StateSnapshotEvent` / `StateDeltaEvent` (outbound). In `Microsoft.Extensions.AI` terms, inbound state rides on the request's raw representation and outbound state rides on a `ChatResponseUpdate`'s raw representation.

## Client: seed the state and read it back

Send the starting state with the request, and watch for snapshots in the response:

```csharp
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

var initialState = JsonSerializer.SerializeToElement(new
{
    recipe = new { title = "", ingredients = Array.Empty<string>(), steps = Array.Empty<string>() }
});

var options = new ChatOptions
{
    RawRepresentationFactory = _ => new RunAgentInput { State = initialState },
};

var messages = new List<ChatMessage> { new(ChatRole.User, "Suggest an Italian pasta recipe") };

JsonElement? latestState = null;
await foreach (var update in client.GetStreamingResponseAsync(messages, options))
{
    if (update.RawRepresentation is StateSnapshotEvent snapshot)
    {
        latestState = snapshot.Snapshot;   // the full updated state object
    }
    Console.Write(update.Text);            // the assistant's summary streams as usual
}
```

State updates are **content-less** — they arrive on `update.RawRepresentation`, not as `update.Text`.

## Server: read inbound state and emit the new state

Add a `DelegatingChatClient` to the pipeline that reads `RunAgentInput.State`, produces the new state, and yields it as a `StateSnapshotEvent`:

```csharp
using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using AGUI.Server;
using Microsoft.Extensions.AI;

internal sealed class RecipeStateChatClient(IChatClient inner, JsonSerializerOptions jso)
    : DelegatingChatClient(inner)
{
    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        if (options?.TryGetRunAgentInput(out var input) is true
            && input!.State is { ValueKind: JsonValueKind.Object } incoming)
        {
            var newState = await BuildStateAsync(messages, incoming, ct);   // your logic / an LLM call

            yield return new ChatResponseUpdate
            {
                RawRepresentation = new StateSnapshotEvent
                {
                    Snapshot = JsonSerializer.SerializeToElement(newState, jso.GetTypeInfo(typeof(AgentState))),
                },
            };
        }

        await foreach (var update in base.GetStreamingResponseAsync(messages, options, ct))
        {
            yield return update;   // the assistant's text summary
        }
    }
}
```

Register it after function invocation:

```csharp
builder.Services.AddChatClient(/* provider IChatClient */)
    .UseFunctionInvocation()
    .Use((inner, sp) => new RecipeStateChatClient(
        inner, sp.GetRequiredService<IOptions<JsonOptions>>().Value.SerializerOptions));
```

`TryGetRunAgentInput` recovers the originating `RunAgentInput` from the `ChatOptions` the endpoint built — that is how the server-side chat client reaches `State` (and thread id, tools, …) without endpoint plumbing.

## Snapshots vs deltas

- **`StateSnapshotEvent`** carries the entire state object. Simple and self-correcting; send it when the whole state changed or you want to resync.
- **`StateDeltaEvent`** carries a JSON Patch (RFC 6902) array of changes against the last known state. Use it for small, frequent edits to a large object to avoid resending everything. The client applies the patch to its copy.

## AOT-safe state types

State objects are serialized through the source-generated context. Put each state type in a `JsonSerializerContext`, register it on the host (`ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Add(...))`), and serialize through `jso.GetTypeInfo(typeof(T))` rather than reflection.

## Anti-patterns

- **Aggregating the response instead of streaming it.** `StateSnapshotEvent` / `StateDeltaEvent` arrive on content-less updates, which the non-streaming aggregation drops. Read state inside the `await foreach` over the streaming response.
- **Sending a delta against state the client never received.** A `StateDeltaEvent` patches the client's last known state; if the client missed the prior snapshot the patch fails to apply. Start a session (or resync) with a full `StateSnapshotEvent`, then send deltas.

## Verify

1. The client sends a non-empty `State` and the run streams back at least one `StateSnapshotEvent` whose `Snapshot` reflects the agent's changes.
2. The assistant text and the state both arrive in the same run; reading `update.RawRepresentation` yields the `StateSnapshotEvent` while `update.Text` yields the summary.
3. If using deltas: applying the streamed JSON Patch to the prior state produces the same object a full snapshot would.
