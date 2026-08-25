---
name: agui-dotnet-transport
description: >
  Add or modify a wire transport / event-stream encoding in the AG-UI .NET SDK — the protobuf
  codec, the SSE format, content negotiation, the JsonElement-to-protobuf Value bridge, or a brand
  new encoding — while preserving Native AOT compatibility and byte-level wire compatibility with
  @ag-ui/proto. USE FOR: working on AGUI.Formatting / AGUI.Protobuf, IAGUIEventStreamFormatter,
  transport content negotiation, the JsonElement-to-google.protobuf.Value bridge, SSE or protobuf
  framing, server formatter registration / AGUIResults.Events negotiation. DO NOT USE FOR: adding a new wire event
  TYPE (use agui-dotnet-wire-types), writing tests (use agui-dotnet-integration-tests).
---

# AG-UI .NET Transport & Encoding

Encodes the non-obvious design constraints of the AG-UI .NET transport layer, discovered while
building protobuf support. Apply when adding/changing an encoding or the negotiation that selects
one. Read `references/wire-format.md` before touching the protobuf codec or framing.

## Transport architecture

One bidirectional abstraction, `IAGUIEventStreamFormatter` (in `AGUI.Formatting`), serves every
transport and both directions:

| Member | Role |
|--------|------|
| `MediaType` | Advertised in client `Accept` and written as server `Content-Type`. Registration order = preference. |
| `CanRead(contentType)` | Client picks the decoder for the response `Content-Type`. |
| `ReadAsync(body, ct)` | Decode body → `IAsyncEnumerable<BaseEvent>`. |
| `WriteAsync(events, output, ct)` | Encode events → body. |

`SseEventStreamFormatter` (`text/event-stream`) is the always-available default;
`ProtobufEventStreamFormatter` (`ProtobufEventStreamFormatter.ProtobufMediaType`) is opt-in.

**Client negotiation** = `DelegatingHandler` + decode helper:
- `AGUIEventStreamHandler` (public, in `AGUI.Client`) advertises every registered formatter's
  `MediaType` in `Accept`, then inspects the response `Content-Type`, finds the first `CanRead`
  formatter, and records it on the request. The body is left untouched for lazy streaming.
- `AGUIResponseExtensions.ReadAGUIEventStreamAsync` reads that recorded formatter (falling back to
  SSE) and decodes. The SDK ships no `IHttpClientFactory` integration: a caller that wants protobuf
  wires the handler into its own `HttpClient`, and constructs `AGUIChatClient` from
  `AGUIChatClientOptions`.

**Server negotiation** = `AGUIResults.Events` (samples `AGUI.Samples.Shared`): collects registered
`IAGUIEventStreamFormatter` services (+ built-in SSE), then picks protobuf **only when its media
type is explicitly present** in `Accept` with non-zero quality, else SSE for `text/event-stream`/
wildcard/absent, else `406`. Mirrors `preferredMediaTypes(accept, [proto])` in `@ag-ui/encoder`.
A server opts in by registering the formatter (for example,
`services.AddSingleton<IAGUIEventStreamFormatter, ProtobufEventStreamFormatter>()`).

## Wire format facts

- Protobuf media type: `application/vnd.ag-ui.event+proto` (`ProtobufEventStreamFormatter.ProtobufMediaType`).
- Framing: **4-byte big-endian `uint32` length prefix + protobuf message bytes**, per event —
  matches `@ag-ui/encoder` `encodeProtobuf` (`dataView.setUint32(0, length, false)`). See
  `AGUIProtobuf.WriteFramed` / `ReadFramedAsync`.
- `Encode`/`Decode` = single message, no length prefix (mirror TS `proto.encode`/`proto.decode`).
- Dynamic payloads (state, args, results) use `google.protobuf.Value` (Struct/ListValue/scalars) —
  **never `Any` and never a JSON-string field**.

## The CRITICAL Native AOT rule

Implement the `JsonElement` <-> `google.protobuf.Value` bridge **by hand over the generated
WellKnownTypes** (`ProtoValueConverter`). **NEVER** use Google.Protobuf's reflection-based
`JsonFormatter`/`JsonParser` or any descriptor reflection API — they are not trim/AOT safe and the
package multi-targets `net10/9/8/netstandard2.0/net472`.

- **Number caveat**: `Value` is double-only. `long`/`decimal` beyond 2^53 lose precision on round
  trip. This is intentional — it matches the JS `@ag-ui/proto` limitation.

## Schema-first extension

The `.proto` schema is **canonical** and lives in the TS package. `AGUI.Protobuf.csproj`
`<Protobuf>` references `sdks/typescript/packages/proto/src/proto/*.proto` directly
(`csharp_namespace = AGUI.ProtocolBuffers`, generated types `Access="Internal"`) — **do not fork or
copy it**. To add a wire-representable event:

1. Extend the shared `.proto` (coordinated across all SDKs — it is the cross-language contract).
2. Add a mapper case in `ProtoEventMapper` (event oneof) / `ProtoMessageMapper` (messages),
   mirroring `sdks/typescript/packages/proto/src/proto.ts` reshaping verbatim.

Subset coverage is intentional: .NET-only events that have no wire representation throw
`NotSupportedException` from the mapper's `default` case. Don't invent a wire shape unilaterally.

## How to verify

- **Byte-parity** against `@ag-ui/proto` via the cross-language tests (see
  `agui-dotnet-integration-tests` and `sdks/dotnet/docs/cross-language-testing.md`). The JSON
  compatibility fixtures in `tests/AGUI.Abstractions.UnitTests/Compatibility/` guard SSE drift.
- **Multi-TFM AOT build**: `dotnet build` from `sdks/dotnet/` (targets net10/9/8/netstandard2.0/
  net472; warnings are errors). Update `PublicAPI.Unshipped.txt` for any public surface change.

## ❌ Anti-patterns

1. **Don't embed JSON-as-string inside a `Value`.** Map structured payloads recursively to
   Struct/ListValue/scalars via `ProtoValueConverter`. A string field breaks @ag-ui/proto parity.
2. **Don't use `JsonFormatter`/`JsonParser`/descriptor reflection.** Not AOT-safe — hand-write the
   bridge over generated WellKnownTypes.
3. **Don't copy or fork the `.proto`.** Reference the canonical TS schema from the `.csproj` so the
   codec can't drift from the wire contract.
4. **Don't make `AGUI.Protobuf` depend on `AGUI.Client` or the hosting/server package.** The codec
   stays transport-neutral; it references only `AGUI.Abstractions` + `AGUI.Formatting`.
5. **Don't change framing or use little-endian.** Length is big-endian `uint32`; both SDKs depend
   on exact byte layout.

## References

- **Wire format & codec internals** (framing, oneof mapping, Value bridge, negotiation parity):
  [references/wire-format.md](references/wire-format.md)
