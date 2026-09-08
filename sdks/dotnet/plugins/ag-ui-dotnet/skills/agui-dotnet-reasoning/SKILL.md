---
name: agui-dotnet-reasoning
description: >
  Surface a reasoning/thinking model's intermediate thoughts separately from its final answer with the AG-UI .NET SDK — so a client can show the agent "thinking" before it responds, and handle that reasoning trace correctly across turns. USE FOR: distinguishing the model's reasoning trace from its answer on the client by matching TextReasoningContent vs TextContent in each ChatResponseUpdate's Contents; rendering thinking and answer in different ways as they stream; deciding whether to carry the reasoning text into later turns (whether to append/resend the model's reasoning back into conversation history). DO NOT USE FOR: plain text streaming with no reasoning display (use agui-dotnet-streaming-chat); tools, shared state, interrupts, multimodal, generative UI, or protobuf.
---

# AG-UI .NET — reasoning (thinking) events

Goal: show a reasoning model's intermediate thoughts as they stream, kept visually separate from the final answer.

A reasoning model emits two kinds of text in the stream: its thinking and its answer. In `Microsoft.Extensions.AI` these arrive as different content types on each `ChatResponseUpdate` — `TextReasoningContent` for the thoughts, `TextContent` for the answer. `update.Text` only concatenates the answer parts, so to display thinking you inspect `update.Contents`.

## Separate thinking from the answer

Iterate `update.Contents` and branch on the content type instead of reading `update.Text`:

```csharp
using Microsoft.Extensions.AI;

var messages = new List<ChatMessage>
{
    new(ChatRole.User, "20 heads, 56 legs — how many chickens and rabbits? Show your reasoning."),
};

await foreach (var update in client.GetStreamingResponseAsync(messages))
{
    foreach (var content in update.Contents)
    {
        switch (content)
        {
            case TextReasoningContent { Text: { Length: > 0 } thinking }:
                RenderThinking(thinking);   // e.g. a dimmed/collapsible panel
                break;
            case TextContent { Text: { Length: > 0 } answer }:
                RenderAnswer(answer);       // the user-facing reply
                break;
        }
    }
}
```

Both stream incrementally and can interleave: thinking deltas arrive, then answer deltas. Render each as it comes rather than buffering, so the "thinking…" state is visible before the answer lands.

## Anti-patterns

- **Re-sending the reasoning text as conversation history.** The thinking is scratch work for a single turn, not a message. Appending captured `TextReasoningContent` into the next request's messages bloats the prompt, and some providers reject prior reasoning as input. Carry forward only the assistant's answer.
- **Treating reasoning as part of the answer.** The thinking is a separate channel; concatenating it into the reply shows the user the model's scratch work as if it were the response. Keep the two render paths distinct.

## Verify

1. For a prompt that asks the model to reason, the stream yields `TextReasoningContent` updates before the final `TextContent` answer.
2. The rendered answer contains only the response, with the reasoning shown (or hidden) through its own path — not mixed into the answer text.
