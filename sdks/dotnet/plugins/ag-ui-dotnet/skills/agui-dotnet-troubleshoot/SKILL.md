---
name: agui-dotnet-troubleshoot
description: >
  Diagnose and fix problems in an AG-UI .NET app built on the AG-UI SDK — when streaming chat, tools, state, interrupts, or the transport misbehave. USE FOR: the agent forgetting earlier turns / history truncated; update.ConversationId always null; state or lifecycle updates that never arrive; a tool throwing at runtime or producing AOT/trim warnings; an unknown-tool error mid-run; 406 Not Acceptable from the endpoint; an interrupt or approval that won't resume; and inspecting the raw AG-UI event stream (curl SSE frames, RawEvent on ChatResponseUpdate.RawRepresentation) to see what's actually on the wire. DO NOT USE FOR: first-time setup or the happy path (use agui-dotnet-streaming-chat); implementing a specific feature cleanly (use the matching agui-dotnet-* skill).
---

# AG-UI .NET — troubleshooting

Goal: map a symptom to its cause and fix in an AG-UI .NET app.

## The agent forgets earlier turns / history is truncated

The server is stateless and keeps nothing between turns, so the client must resend the full history each turn. If you send only the latest message, the model loses all prior context.

Fix: keep a running `List<ChatMessage>`, append the assistant reply (`history.AddMessages(updates.ToChatResponse())`), and resend the whole list. For a server that holds the conversation, keep the thread id stable by reusing the same `ChatOptions` instance across turns.

## `update.ConversationId` is always null

This is by design — the SDK never surfaces a service conversation id. A non-null `ConversationId` would make `Microsoft.Extensions.AI` wrappers send only deltas, which truncates history against a stateless server.

Fix: don't track conversations by `ConversationId`. Use the thread id from the `RUN_STARTED` event (`update.RawRepresentation as RunStartedEvent`), or just reuse the same `ChatOptions` to keep one stable thread.

## State, reasoning, or lifecycle updates never arrive

These ride on **content-less** updates — `update.RawRepresentation` (a `StateSnapshotEvent`, `RunStartedEvent`, `RawEvent`, …) with no text. The non-streaming `GetResponseAsync` aggregation drops updates that carry no message content.

Fix: consume the streaming API (`await foreach` over `GetStreamingResponseAsync`) and inspect `update.RawRepresentation` / `update.Contents` inside the loop, rather than aggregating to a single `ChatResponse`.

## A tool throws at runtime or emits AOT/trim warnings

A tool whose argument or result type is non-primitive needs source-generated serialization; reflection-based schema/binding fails under Native AOT and trimming.

Fix: put the tool's parameter and result types in a `JsonSerializerContext`, register it on the host (`ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Add(...))`), and pass it to `AIFunctionFactory.Create(method, serializerOptions: ctx.Options)`.

## An unknown-tool call errors mid-run

When the client declares a tool the server doesn't own, the server's function-invoking client tries to execute it and fails — unless told the call belongs elsewhere.

Fix: register the server chat client with `.UseFunctionInvocation(fic => fic.TerminateOnUnknownCalls = true)`. The unknown (client) tool then ends the server turn cleanly and is forwarded to the client to execute.

## The endpoint returns 406 Not Acceptable

Transport is content-negotiated. A 406 means the request's `Accept` header asked for a format the server can't produce (e.g. protobuf with no protobuf formatter registered, or an `Accept` that excludes `text/event-stream`).

Fix: make the client accept a format the server offers. For SSE, allow `text/event-stream` (or `*/*`); for protobuf, register `ProtobufEventStreamFormatter` on the server and list it in the client's `AGUIEventStreamHandler`.

## An interrupt or approval won't resume

Resuming a paused run needs **both** the request and the matching response in the resumed message list, sharing the same id — the SDK pairs them to reconnect to the paused call.

Fix: append both — the `ToolApprovalRequestContent` (or `InterruptRequestContent`) on an assistant message and its `CreateResponse(...)` / `InterruptResponseContent(requestId)` on a user message — then stream again. Sending the response alone leaves nothing to resume.

## Inspecting what's on the wire

See the raw event frames directly with curl:

```bash
curl -N -X POST http://localhost:5000/ \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"Hi"}]}'
```

A healthy run shows `RUN_STARTED` … `TEXT_MESSAGE_CONTENT` … `RUN_FINISHED`. A paused run ends `RUN_FINISHED { outcome: interrupt }`. Tool runs show `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` / `TOOL_CALL_RESULT`.

In code, telemetry and custom server events surface as a `RawEvent` on the update:

```csharp
if (update.RawRepresentation is RawEvent { Source: var source, Event: var payload })
{
    Console.WriteLine($"[{source}] {payload.GetRawText()}");
}
```

## Verify the fix

After applying a fix, reproduce the original prompt and confirm the symptom is gone against the wire stream — e.g. the second turn now reflects the first (history), the `StateSnapshotEvent` now arrives (streaming), or the response `Content-Type` now matches the negotiated transport (406).
