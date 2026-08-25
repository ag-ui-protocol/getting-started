---
name: agui-dotnet-streaming-chat
description: >
  Get started with the AG-UI .NET SDK: bootstrap and run your first streaming-chat
  app (client + server) with the AG-UI .NET NuGet packages (AGUI.Client,
  AGUI.Server, AGUI.Formatting, AGUI.Abstractions). USE FOR: which packages to
  install and how to wire them; constructing an AGUIChatClient against an endpoint
  and streaming the reply as Microsoft.Extensions.AI IChatClient /
  ChatResponseUpdate; hosting an AG-UI POST endpoint yourself over any IChatClient;
  running a single- or multi-turn conversation; STATELESS agents (client owns
  history, resends it every turn) vs HOSTED / conversation-holding agents (server
  keeps the session, client pins a thread id). DO NOT USE FOR: changing the AG-UI
  .NET SDK itself (use the agui-dotnet-* contributor skills); server tools
  (agui-dotnet-server-tools); client tools (agui-dotnet-client-tools); interrupts /
  human-in-the-loop; shared state; generative UI; multimodal; or protobuf transport.
---

# Getting started with AG-UI .NET — streaming chat

Goal: install the packages, stand up an AG-UI endpoint, connect a client, and stream a multi-turn conversation. **You are done when you run the client and it prints a streamed reply.**

## The two agent types (read this first)

How you keep a conversation going depends on **who owns the history**:

- **Stateless agent (the default).** The server keeps nothing between turns — it is a pure function of the request. The **client** owns the history and resends the full message list every turn. This is where you start.
- **Hosted / conversation-holding agent.** A server (or runtime) persists the conversation in a session keyed by the **thread id**, so it can recall history. The client sends the new turn under a stable thread id. Covered [below](#hosted-agents).

`AGUIChatClient` is a `Microsoft.Extensions.AI.IChatClient`, so you consume it with the ordinary `GetStreamingResponseAsync(messages, options, ct)` API.

**Thread id.** Every conversation has one — it is the stable identifier for the whole exchange. Keep it stable across turns by **reusing the same `ChatOptions` instance**: `AGUIChatClient` pins the resolved thread id onto it after the first turn. (The SDK never surfaces it as `ConversationId` — `update.ConversationId` is always `null` by design, issue #4869 — so don't use `ConversationId` to track a conversation.)

## Install the packages

Client app:

```bash
dotnet add package AGUI.Client
```

Server app:

```bash
dotnet add package AGUI.Server      # RunAgentInput adaptation + event-stream conversion
dotnet add package AGUI.Formatting  # SseEventStreamFormatter (writes the SSE wire format)
```

`dotnet add package` installs the latest stable version. To discover versions or pin one:

```bash
dotnet package search AGUI.Client --exact-match   # show the latest version on nuget.org
dotnet add package AGUI.Client --prerelease        # install latest, including prereleases
dotnet add package AGUI.Client --version <x.y.z>   # pin a specific version
```

`AGUI.Abstractions` (protocol types such as `RunAgentInput` and `RunStartedEvent`) comes in transitively with both. On the server you also use `Microsoft.Extensions.AI` (`AddChatClient`, `IChatClient`) plus a chat-client provider of your choice (OpenAI, Azure OpenAI, Ollama, …).

## Stateless: the client

Construct it from an `AGUIChatClientOptions` (here via the `(HttpClient, endpoint)` options constructor):

```csharp
using AGUI.Client;
using Microsoft.Extensions.AI;

using var httpClient = new HttpClient();
IChatClient client = new AGUIChatClient(new(httpClient, "http://localhost:5001"));

await foreach (var update in client.GetStreamingResponseAsync(
    new List<ChatMessage> { new(ChatRole.User, "Hello") }))
{
    Console.Write(update.Text); // text deltas stream in as they arrive
}
```

You own the `HttpClient`. The transport defaults to Server-Sent Events.

## Stateless: the server

Host the endpoint yourself: receive `RunAgentInput`, adapt it to Microsoft.Extensions.AI, stream from any `IChatClient`, convert to AG-UI events, and write them as SSE.

```csharp
using AGUI.Abstractions;
using AGUI.Formatting;
using AGUI.Server;
using Azure.AI.OpenAI;
using Azure.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

var builder = WebApplication.CreateBuilder(args);

// Register your chat client. Any Microsoft.Extensions.AI provider works
// (OpenAI, Ollama, a local model, …); Azure OpenAI is shown here.
builder.Services.AddChatClient(
    new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential())
        .GetChatClient(deploymentName)
        .AsIChatClient());

// SseEventStreamFormatter is stateless — register it once as a singleton.
builder.Services.AddSingleton<IAGUIEventStreamFormatter, SseEventStreamFormatter>();

var app = builder.Build();

app.MapPost("/", async (
    [FromBody] RunAgentInput input,
    IChatClient chatClient,
    IAGUIEventStreamFormatter formatter,
    IOptions<JsonOptions> jsonOptions,
    HttpContext http,
    CancellationToken ct) =>
{
    var jso = jsonOptions.Value.SerializerOptions;

    // 1) RunAgentInput -> messages + ChatOptions
    var ctx = input.ToChatRequestContext(jso);

    // 2) Stream from the model
    var updates = chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, ct);

    // 3) ChatResponseUpdate stream -> AG-UI event stream
    var events = updates.AsAGUIEventStreamAsync(ctx, ct);

    // 4) Write the events using the injected (singleton) formatter
    http.Response.ContentType = formatter.MediaType;
    http.Response.Headers.CacheControl = "no-cache";
    await formatter.WriteAsync(events, http.Response.Body, ct);
});

app.Run();
```

That is the whole server contract. If you later expose server-executed tools, add `.UseFunctionInvocation()` to the chat-client registration — not needed for plain chat.

## Stateless: multi-turn (carry the history)

A stateless server has no memory, so the **client** keeps the running `List<ChatMessage>`: append the assistant reply, then add the next user turn. Reuse the same `ChatOptions` so the thread id stays stable across the conversation.

```csharp
var messages = new List<ChatMessage> { new(ChatRole.User, "Hello") };
var options = new ChatOptions();

await SendAsync(messages, options);

messages.Add(new ChatMessage(ChatRole.User, "How are you?"));
await SendAsync(messages, options);

async Task SendAsync(List<ChatMessage> history, ChatOptions options)
{
    var updates = new List<ChatResponseUpdate>();
    await foreach (var update in client.GetStreamingResponseAsync(history, options))
    {
        Console.Write(update.Text);          // stream the reply as it arrives
        updates.Add(update);
    }
    Console.WriteLine();

    history.AddMessages(updates.ToChatResponse());   // carry the reply into the next turn
}
```

`AGUIChatClient` sends the **full message list every turn** by design — that is how a stateless server sees prior context.

## Run it (definition of done)

1. Start the server: `dotnet run` in the server project (listening on, e.g., `:5001`).
2. Run the client against it. **It works when the client prints the reply incrementally** (multiple non-empty `update.Text` chunks, not one blob at the end).
3. Smoke-test the server directly:
   ```bash
   curl -N -X POST http://localhost:5001/ -H "Content-Type: application/json" \
     -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"Hello"}]}'
   ```
You should see `data: {...}` SSE frames: `RUN_STARTED` … `TEXT_MESSAGE_CONTENT` … `RUN_FINISHED`.
4. Multi-turn keeps context: the second answer reflects the first exchange.

## Hosted agents

Use this when the server holds the conversation (a session store keyed by thread id). The server recalls history from the thread id, so the client just needs to keep that thread id stable — reusing the same `ChatOptions` (above) is usually enough. Two extra tools for when you need them:

- **Pin a known thread id** (resuming a session created earlier): set it as `ConversationId` — `AGUIChatClient` maps it inward to the AG-UI thread id.

  ```csharp
  var options = new ChatOptions { ConversationId = threadId };
  ```

- **Read the thread id / run id** for a turn — they ride on the `RUN_STARTED` event, exposed as the update's `RawRepresentation`:

  ```csharp
  using AGUI.Abstractions;

  string? threadId = null, runId = null;
  await foreach (var u in client.GetStreamingResponseAsync(messages, options))
  {
      if (u.RawRepresentation is RunStartedEvent started)
      {
          threadId = started.ThreadId;
          runId = started.RunId;
      }
      Console.Write(u.Text);
  }
  ```

- **Advanced — set wire-level fields with no `ChatOptions` equivalent.** For example `ParentRunId`, to chain one run onto the previous. Supply it via `RawRepresentationFactory`; messages still flow through the normal call argument, and to send only the new turn you simply pass a shorter list:

  ```csharp
  var options = new ChatOptions
  {
      RawRepresentationFactory = _ => new RunAgentInput { ParentRunId = runId },
  };

  await foreach (var update in client.GetStreamingResponseAsync(newMessages, options))
  {
      Console.Write(update.Text);
  }
  ```

Send only the new messages this way only when the server truly owns history; otherwise prefer the full-history stateless pattern, which works against any AG-UI server.

## Anti-patterns

- **Reusing one `ChatOptions` across different conversations.** The thread id pins onto the options instance, so a second, unrelated conversation inherits the first one's thread id — and against a hosted server the two get merged into one session. Use a fresh `ChatOptions` per conversation; reuse it only across turns of the *same* one.
- **Calling `GetResponseAsync` when you want streaming.** It returns only the final aggregated response — no incremental text, and content-less updates (lifecycle and state events) do not survive the aggregation. Use `GetStreamingResponseAsync`.
