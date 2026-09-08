---
name: agui-dotnet-client-tools
description: >
  Expose client-side (frontend) tools to an AG-UI agent with the AG-UI .NET SDK — C# functions that run in the CLIENT app (read local state, GPS, UI, device APIs), where the client executes the call and returns the result so the run continues. USE FOR: declaring an AIFunction in the client and passing it via ChatOptions.Tools to AGUIChatClient; having the client execute a tool the model requested and feed the result back automatically; understanding why no UseFunctionInvocation is needed on the client (AGUIChatClient already invokes functions); what the server must do (UseFunctionInvocation + TerminateOnUnknownCalls) so it forwards an unknown/client tool instead of erroring. DO NOT USE FOR: tools that run on the server/backend (use agui-dotnet-server-tools); pausing for human approval/input before acting (interrupts / human-in-the-loop); plain chat (use agui-dotnet-streaming-chat); shared state, generative UI, multimodal, or protobuf.
---

# AG-UI .NET — client (frontend) tools

Goal: let the model call a function that runs in the client app — to read something only the client has (location, local state, UI selection, a device API) — with the client executing the call and returning the result so the run continues to a final answer.

A client tool is an ordinary `Microsoft.Extensions.AI` `AIFunction` you attach to the request via `ChatOptions.Tools`. `AGUIChatClient` is itself a function-invoking client, so it runs the tool locally and sends the result back automatically — you do not wrap it in `UseFunctionInvocation`.

## Install

```bash
dotnet add package AGUI.Client
```

`Microsoft.Extensions.AI` supplies `AIFunctionFactory`, `ChatOptions`, and `AITool`. Run `dotnet package search AGUI.Client --exact-match` for the current version.

## Declare a tool and pass it in options

Define the function in the client, wrap it with `AIFunctionFactory.Create`, and put it on `ChatOptions.Tools`:

```csharp
using System.ComponentModel;
using AGUI.Client;
using Microsoft.Extensions.AI;

[Description("Get the user's current location from GPS.")]
static string GetUserLocation() => "Amsterdam, Netherlands (52.37°N, 4.90°E)";

using var httpClient = new HttpClient();
IChatClient client = new AGUIChatClient(new(httpClient, "http://localhost:5003"));

var options = new ChatOptions { Tools = [AIFunctionFactory.Create(GetUserLocation)] };

var messages = new List<ChatMessage> { new(ChatRole.User, "What's fun to do near me?") };

await foreach (var update in client.GetStreamingResponseAsync(messages, options))
{
    Console.Write(update.Text);
}
```

When the model decides to call `GetUserLocation`, `AGUIChatClient` invokes it on this machine, returns the result to the server, and the run continues — the streamed text you print already reflects the location.

## What the server must do

The server forwards a tool it doesn't own to the client instead of trying to run it. Register the server's chat client with function invocation and `TerminateOnUnknownCalls` so an unknown (client) tool ends the server turn cleanly and is surfaced to the client to execute:

```csharp
builder.Services.AddChatClient(/* provider IChatClient */)
    .UseFunctionInvocation(fic => fic.TerminateOnUnknownCalls = true);
```

The server declares none of the client's tools; it only needs to forward them.

## Anti-patterns

- **Wrapping the client in `UseFunctionInvocation`.** `AGUIChatClient` already invokes functions; adding another function-invoking layer double-handles the call and can execute it twice or strip the AG-UI tool routing. Pass the tool through `ChatOptions.Tools` and let the client invoke it.
- **A client tool that returns before the side effect it reports completes.** The model continues the run the instant the function returns, so a tool that says "saved" while an async write is still in flight makes the model narrate a result that has not happened. Await the real work inside the function before returning.

## Verify

1. Run a prompt the model can only answer using the client tool. The function body executes locally (set a breakpoint or log inside it).
2. The streamed answer reflects the tool's return value, and the run ends `RUN_FINISHED` in a single client call — you wrote no code to send the tool result back.
