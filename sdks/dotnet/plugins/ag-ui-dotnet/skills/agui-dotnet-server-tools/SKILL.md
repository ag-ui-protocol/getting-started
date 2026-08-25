---
name: agui-dotnet-server-tools
description: >
  Expose server-side (backend) tools an AG-UI agent can call with the AG-UI .NET SDK — C# functions that run on the server, where the server executes the call and feeds the result back to the model. USE FOR: defining an AIFunction with AIFunctionFactory.Create and registering it on the server's IChatClient via ConfigureOptions + UseFunctionInvocation; making the model call your backend function during a run; AOT-safe tool arguments/results (registering a JsonSerializerContext for complex tool parameter types); parallel/concurrent backend tool calls (AllowConcurrentInvocation); TerminateOnUnknownCalls behavior. DO NOT USE FOR: tools that run in the client/frontend (use agui-dotnet-client-tools); pausing a tool for human approval or input (interrupts / human-in-the-loop); plain streaming chat with no tools (use agui-dotnet-streaming-chat); shared state, generative UI, multimodal, or protobuf.
---

# AG-UI .NET — server (backend) tools

Goal: let the model call a C# function that runs on your server, with the server executing the call and returning the result so the run continues to a final answer.

A server tool is an ordinary `Microsoft.Extensions.AI` `AIFunction` registered on the server's `IChatClient`. The `FunctionInvokingChatClient` executes it inside the run; the client sends no tools and needs no tool code, and receives the final answer. Tool-call and result events still cross the wire — the client just never executes anything.

## Install

```bash
dotnet add package AGUI.Server
dotnet add package AGUI.Formatting
```

`Microsoft.Extensions.AI` supplies `AIFunctionFactory`, `AddChatClient`, and `UseFunctionInvocation`. Run `dotnet package search AGUI.Server --exact-match` for the current version.

## Define and register a tool

Create the function with `AIFunctionFactory.Create`, add it to the chat client's tools, and enable function invocation:

```csharp
using System.ComponentModel;
using Microsoft.Extensions.AI;

[Description("Search for restaurants in a location.")]
static RestaurantSearchResponse SearchRestaurants(
    [Description("Where to search and what cuisine.")] RestaurantSearchRequest request)
{
    // ... real lookup ...
}

var builder = WebApplication.CreateBuilder(args);

var searchRestaurants = AIFunctionFactory.Create(
    SearchRestaurants,
    serializerOptions: SampleJsonSerializerContext.Default.Options);

builder.Services.AddChatClient(
        new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential())
            .GetChatClient(deploymentName)
            .AsIChatClient())
    .ConfigureOptions(o => (o.Tools ??= []).Add(searchRestaurants))
    .UseFunctionInvocation(fic => fic.TerminateOnUnknownCalls = true);
```

The `[Description]` attributes become the tool and parameter schema the model sees. Any `Microsoft.Extensions.AI` provider works in place of Azure OpenAI.

## AOT-safe tool arguments and results

When a tool takes or returns a complex type (anything beyond primitives), its schema and (de)serialization must be source-generated, not reflection-based. Put the parameter and result types in a `JsonSerializerContext`, register it on the host's JSON options, and pass it to `AIFunctionFactory.Create`:

```csharp
[JsonSerializable(typeof(RestaurantSearchRequest))]
[JsonSerializable(typeof(RestaurantSearchResponse))]
internal sealed partial class SampleJsonSerializerContext : JsonSerializerContext;

builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.TypeInfoResolverChain.Add(SampleJsonSerializerContext.Default));

var searchRestaurants = AIFunctionFactory.Create(
    SearchRestaurants,
    serializerOptions: SampleJsonSerializerContext.Default.Options);
```

The same context is registered on the host (so the wire `RunAgentInput` round-trips the types) and passed to the function (so its argument binding uses source-gen).

## Host the endpoint

The endpoint streams the registered `IChatClient` — function calls are resolved server-side inside the stream before any text reaches the client:

```csharp
using AGUI.Abstractions;
using AGUI.Formatting;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

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
    var ctx = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);
    var updates = chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, ct);
    var events = updates.AsAGUIEventStreamAsync(ctx, ct);

    http.Response.ContentType = formatter.MediaType;
    http.Response.Headers.CacheControl = "no-cache";
    await formatter.WriteAsync(events, http.Response.Body, ct);
});

app.Run();
```

## Parallel tool calls

When the model requests several tool calls in one turn, let the function-invoking client run them concurrently:

```csharp
.UseFunctionInvocation(fic =>
{
    fic.TerminateOnUnknownCalls = true;
    fic.AllowConcurrentInvocation = true;
});
```

The model decides whether to batch calls; `AllowConcurrentInvocation` only controls whether the already-requested calls execute in parallel instead of serially.

## Anti-patterns

- **Registering a tool with complex parameters but no source-gen context.** Reflection-based schema generation breaks under Native AOT and trimming. Every non-primitive tool argument or result type needs a `JsonSerializerContext` entry, registered on the host and passed to `AIFunctionFactory.Create`.
- **Leaving `TerminateOnUnknownCalls` at its default when client tools are also in play.** With it set, a tool the server doesn't own (one the client declared) ends the server run cleanly so the client can execute it; without it the unknown call surfaces as an error mid-run.

## Verify

1. Send a prompt that needs the tool and watch the stream: a `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` followed by a `TOOL_CALL_RESULT`, then assistant text that uses the result — all within one run that ends `RUN_FINISHED`.
2. The client receives the final answer with no tool code of its own.
3. If targeting Native AOT, `dotnet publish` produces no trim/AOT warnings for the tool types.
