---
name: agui-dotnet-multimodal
description: >
  Send images and other binary/file content to an AG-UI agent with the AG-UI .NET SDK — attach pictures (or audio, PDFs, etc.) to a user message so a multimodal model can see them. USE FOR: building a user ChatMessage with mixed content parts (TextContent plus DataContent for inline bytes, or UriContent for a hosted URL); choosing inline bytes vs a URL reference; setting the correct media type; sending the message through AGUIChatClient so the content parts cross the AG-UI wire to a vision/multimodal model. DO NOT USE FOR: plain text chat (use agui-dotnet-streaming-chat); tool calls (use agui-dotnet-server-tools / agui-dotnet-client-tools); structured shared state (use agui-dotnet-shared-state); reasoning traces, interrupts, generative UI, or protobuf.
---

# AG-UI .NET — multimodal messages

Goal: include an image (or other binary content) in a turn so a multimodal model can describe or reason about it.

A multimodal message is an ordinary `Microsoft.Extensions.AI` `ChatMessage` whose `Contents` mixes a `TextContent` with one or more binary parts. `AGUIChatClient` carries those parts across the AG-UI wire; the server streams the model's reply as usual.

## Install

```bash
dotnet add package AGUI.Client
```

`Microsoft.Extensions.AI` supplies `ChatMessage`, `TextContent`, `DataContent`, and `UriContent`.

## Attach inline bytes

Use `DataContent(bytes, mediaType)` to embed the data directly in the message:

```csharp
using AGUI.Client;
using Microsoft.Extensions.AI;

byte[] imageBytes = await File.ReadAllBytesAsync("photo.png");

var messages = new List<ChatMessage>
{
    new(ChatRole.User,
    [
        new TextContent("Describe this image"),
        new DataContent(imageBytes, "image/png"),
    ]),
};

await foreach (var update in client.GetStreamingResponseAsync(messages))
{
    Console.Write(update.Text);
}
```

The media type must match the bytes (`image/png`, `image/jpeg`, `audio/wav`, `application/pdf`, …) so the model decodes them correctly.

## Reference a hosted URL

When the asset already lives at a URL, use `UriContent(uri, mediaType)` instead — the bytes never pass through your process:

```csharp
new ChatMessage(ChatRole.User,
[
    new TextContent("What's in this picture?"),
    new UriContent("https://example.com/cat.jpg", "image/jpeg"),
]);
```

Prefer `UriContent` to reference an asset already hosted at a URL; use `DataContent` for local bytes the model host can't reach by URL.

## Anti-patterns

- **Sending a large asset as inline `DataContent`.** Inline binary is base64-encoded into the request, inflating it ~33% and forcing the whole payload through memory on both ends. For anything sizable that is reachable by URL, send `UriContent` and let the model host fetch it.
- **Targeting a model that isn't multimodal.** The content parts cross the wire fine, but a text-only deployment ignores or rejects the image. Point the server's `IChatClient` at a vision-capable model/deployment.

## Verify

1. The assistant's streamed reply describes the actual image content (not a generic "I can't see images" message).
2. The request carries the binary part: the user message on the wire has both a text part and an image/data part with the media type you set.
