---
name: agui-dotnet-protobuf
description: >
  Use the protobuf wire transport (instead of the default Server-Sent Events) for an AG-UI connection with the AG-UI .NET SDK — a compact binary event stream negotiated via the Accept header. USE FOR: making an AGUIChatClient prefer protobuf by wiring an AGUIEventStreamHandler with ProtobufEventStreamFormatter (then SseEventStreamFormatter as fallback) into the HttpClient; enabling a server to answer protobuf by registering ProtobufEventStreamFormatter and negotiating the response format from the request Accept header; understanding the protobuf-or-SSE fallback. DO NOT USE FOR: the default SSE transport or first-time setup (use agui-dotnet-streaming-chat); JSON event serialization questions; tools, state, interrupts, multimodal, or generative UI.
---

# AG-UI .NET — protobuf transport

Goal: carry the AG-UI event stream as compact protobuf binary instead of Server-Sent Events, with automatic fallback to SSE when one side doesn't support it.

Transport is negotiated by content type: the client advertises the formats it accepts (in preference order) on the `Accept` header, and the server replies in the first format it also supports. Nothing above the transport changes — `AGUIChatClient`, messages, and your endpoint logic are identical to SSE.

## Install

```bash
dotnet add package AGUI.Protobuf   # ProtobufEventStreamFormatter
```

Client apps also need `AGUI.Client` (for `AGUIEventStreamHandler`); server apps also need `AGUI.Formatting` (for `SseEventStreamFormatter`) and `AGUI.Server`.

## Client: prefer protobuf, fall back to SSE

Wrap your `HttpClient` in an `AGUIEventStreamHandler` configured with the formatters in preference order. The handler advertises them on `Accept` and decodes whatever the server returns:

```csharp
using AGUI.Client;
using AGUI.Formatting;
using AGUI.Protobuf;
using Microsoft.Extensions.AI;

var handler = new AGUIEventStreamHandler(
    [new ProtobufEventStreamFormatter(), new SseEventStreamFormatter()])
{
    InnerHandler = new HttpClientHandler(),
};

using var httpClient = new HttpClient(handler);
IChatClient client = new AGUIChatClient(new(httpClient, "http://localhost:5013"));
```

Protobuf is listed first, so the client prefers it; if the server only speaks SSE, the handler transparently decodes SSE instead. Switching transports is purely a matter of reordering (or trimming) this formatter list.

## Server: answer protobuf when asked

Register both formatters and pick one per request from the `Accept` header, defaulting to SSE:

```csharp
using System.Linq;
using AGUI.Abstractions;
using AGUI.Formatting;
using AGUI.Protobuf;
using AGUI.Server;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

builder.Services.AddSingleton<IAGUIEventStreamFormatter, SseEventStreamFormatter>();
builder.Services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>();

var app = builder.Build();

app.MapPost("/", async (
    [FromBody] RunAgentInput input,
    IChatClient chatClient,
    IEnumerable<IAGUIEventStreamFormatter> formatters,
    IOptions<JsonOptions> jsonOptions,
    HttpContext http,
    CancellationToken ct) =>
{
    var accept = http.Request.Headers.Accept.ToString();
    var formatter =
        formatters.FirstOrDefault(f => f is ProtobufEventStreamFormatter
                                       && accept.Contains(f.MediaType, StringComparison.OrdinalIgnoreCase))
        ?? formatters.First(f => f is SseEventStreamFormatter);

    var ctx = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);
    var updates = chatClient.GetStreamingResponseAsync(ctx.Messages, ctx.ChatOptions, ct);
    var events = updates.AsAGUIEventStreamAsync(ctx, ct);

    http.Response.ContentType = formatter.MediaType;
    http.Response.Headers.CacheControl = "no-cache";
    await formatter.WriteAsync(events, http.Response.Body, ct);
});
```

Protobuf is selected only when the client *explicitly* accepts its media type, so a default SSE client keeps working unchanged.

## Anti-patterns

- **Registering the protobuf formatter on only one side.** Negotiation needs both ends to agree. If the server registers protobuf but the client's handler lists only SSE (or vice versa), every connection silently falls back to SSE and the binary path is never exercised — verify the chosen `Content-Type`, don't assume.
- **Hand-parsing the protobuf body.** The wire framing must match `@ag-ui/proto` byte-for-byte. Always read and write through `ProtobufEventStreamFormatter`; don't decode the stream yourself.

## Verify

1. With both sides configured, the response `Content-Type` is the protobuf media type (`ProtobufEventStreamFormatter.MediaType`), and the body is binary, not `data:` text frames.
2. Point the same client at an SSE-only server (drop the server's protobuf registration): it keeps working, now over SSE — confirming fallback.
3. The decoded event stream and the assistant output are identical to the SSE transport.
