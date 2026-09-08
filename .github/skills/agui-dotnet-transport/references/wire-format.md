# AG-UI .NET Wire Format & Codec Internals

Deep reference for the protobuf transport. The canonical wire contract is the TypeScript proto
package; the .NET codec mirrors it byte-for-byte.

## Table of contents

1. [File map](#1-file-map)
2. [Binary framing](#2-binary-framing)
3. [The codec surface (AGUIProtobuf)](#3-the-codec-surface-aguiprotobuf)
4. [Event oneof mapping](#4-event-oneof-mapping)
5. [JsonElement <-> google.protobuf.Value bridge](#5-jsonelement---googleprotobufvalue-bridge)
6. [Schema reference & generation](#6-schema-reference--generation)
7. [Content negotiation parity](#7-content-negotiation-parity)
8. [Adding a new encoding](#8-adding-a-new-encoding)
9. [Native AOT / trim constraints](#9-native-aot--trim-constraints)

---

## 1. File map

| File | Responsibility |
|------|----------------|
| `src/AGUI.Formatting/IAGUIEventStreamFormatter.cs` | Bidirectional, transport-agnostic formatter abstraction over a raw `Stream`. |
| `src/AGUI.Formatting/SseEventStreamFormatter.cs` | Default `text/event-stream` formatter; `data: {json}\n\n` records via `AGUIJsonSerializerContext`. |
| `src/AGUI.Protobuf/AGUIProtobuf.cs` | Internal codec entry: `Encode`/`Decode`, `WriteFramed`/`ReadFramedAsync`. |
| `src/AGUI.Protobuf/ProtobufEventStreamFormatter.cs` | The package's only public type: `IAGUIEventStreamFormatter` over the framed codec + `PooledBufferWriter`; owns the `ProtobufMediaType` const. |
| `src/AGUI.Protobuf/ProtoEventMapper.cs` | `BaseEvent` <-> generated `Proto.Event` oneof. |
| `src/AGUI.Protobuf/ProtoMessageMapper.cs` | Message/interrupt/tool sub-mapping. |
| `src/AGUI.Protobuf/ProtoValueConverter.cs` | Hand-written `JsonElement` <-> `Value` bridge. |
| `src/AGUI.Protobuf/JsonElementFactory.cs` | Builds a `JsonElement` from a `Utf8JsonWriter` callback. |
| `src/AGUI.Protobuf/PooledBufferWriter.cs` | Reusable `IBufferWriter<byte>` for per-event encoding. |
| `src/AGUI.Client/AGUIEventStreamHandler.cs` | Public client negotiating `DelegatingHandler` (callers wire it into their own `HttpClient`). |
| `src/AGUI.Client/AGUIResponseExtensions.cs` | `ReadAGUIEventStreamAsync` decode helper. |
| `samples/AGUI.Samples.Shared/AGUIResults.cs` + `AGUIEventStreamResult.cs` | Server-side negotiating `IResult`. |

## 2. Binary framing

Per event: `uint32` big-endian length, then the protobuf message bytes. No trailing delimiter; the
reader loops until the prefix read returns 0 bytes.

```
+--------- 4 bytes ---------+------------- length bytes -------------+
|  big-endian uint32 length |        protobuf Event message          |
+---------------------------+----------------------------------------+
```

TS reference (`@ag-ui/encoder` `encodeProtobuf`): `dataView.setUint32(0, length, false)` — the
`false` is big-endian. .NET writes via `BinaryPrimitives.WriteUInt32BigEndian` in
`AGUIProtobuf.WriteFramed`; reads via `ReadUInt32BigEndian` in `ReadFramedAsync`.
`ReadFramedAsync` uses an internal `ReadExactlyAsync` that distinguishes clean EOF (0 bytes at a
frame boundary → `yield break`) from a truncated payload (`EndOfStreamException`).

## 3. The codec surface (AGUIProtobuf)

| API | Use |
|-----|-----|
| `Encode(BaseEvent) -> byte[]` | One message, no prefix. Mirrors `proto.encode`. |
| `Encode(BaseEvent, IBufferWriter<byte>)` | Same, into a pooled writer. |
| `Decode(ReadOnlySpan<byte>) -> BaseEvent` | One message, no prefix. Mirrors `proto.decode`. |
| `WriteFramed(BaseEvent, IBufferWriter<byte>)` | Length prefix + message. Uses `CalculateSize()` for the prefix. |
| `ReadFramedAsync(Stream, ct)` | Async sequence of framed events. |

`ProtobufEventStreamFormatter.WriteAsync` reuses one `PooledBufferWriter` across events (`Reset()`
per event) and flushes after each frame so streaming stays incremental.

## 4. Event oneof mapping

`ProtoEventMapper.ToProto`/`FromProto` switch over the .NET event / generated `Proto.Event` oneof.
The per-event reshaping mirrors `sdks/typescript/packages/proto/src/proto.ts` **verbatim** — e.g.:

- `RunFinishedEvent`: polymorphic `Outcome` is flattened to a string `outcome` (`"success"` /
  `"interrupt"` / empty) plus a repeated `interrupts` list; `Result` (a `JsonElement?`) becomes a
  `Value`.
- `StateDeltaEvent`: JSON-Patch op strings <-> a generated enum.
- `CustomEvent`/`StateSnapshotEvent`/tool args: dynamic payloads via `ProtoValueConverter`.

The `default` case throws `NotSupportedException` listing the supported set (RUN_STARTED,
RUN_FINISHED, RUN_ERROR, STEP_STARTED, STEP_FINISHED, TEXT_MESSAGE_START/CONTENT/END,
TOOL_CALL_START/ARGS/END, STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT, RAW, CUSTOM). Coverage is
an intentional subset of the full event set.

## 5. JsonElement <-> google.protobuf.Value bridge

`ProtoValueConverter` is the only correct way to move dynamic JSON across the wire. It recurses over
the generated `Struct` / `ListValue` / `Value` well-known types:

| `JsonValueKind` | `Value` kind |
|-----------------|--------------|
| Object | `StructValue` (recurse each property) |
| Array | `ListValue` (recurse each item) |
| String | `StringValue` |
| Number | `NumberValue` (`element.GetDouble()`) |
| True/False | `BoolValue` |
| Null/Undefined | `NullValue` |

Reverse: `ToJsonElement` writes via `Utf8JsonWriter` (through `JsonElementFactory`) switching on
`Value.KindCase`. Helpers `ToValueOrNull` / `ToJsonElementOrNull` handle optional payloads.

**Double-only caveat**: every number is an IEEE-754 double, so `long`/`decimal` magnitudes beyond
2^53 lose precision on the round trip. This intentionally matches the JS `@ag-ui/proto`
implementation, which has the same limitation. Do not add an `Any`-based or string-encoded escape
hatch to "fix" it — that would break cross-language parity.

## 6. Schema reference & generation

`AGUI.Protobuf.csproj` does **not** contain a copy of the schema. It sets:

```xml
<AGUIProtoRoot>$(MSBuildThisFileDirectory)..\..\..\typescript\packages\proto\src\proto</AGUIProtoRoot>
<Protobuf Include="$(AGUIProtoRoot)\events.proto;$(AGUIProtoRoot)\types.proto;$(AGUIProtoRoot)\patch.proto"
          ProtoRoot="$(AGUIProtoRoot)" GrpcServices="None" Access="Internal" />
```

`Grpc.Tools` generates internal C# types into namespace `AGUI.ProtocolBuffers` (set via
`csharp_namespace` in the `.proto`), referenced in code as `using Proto = AGUI.ProtocolBuffers;`.
Generated types are `Access="Internal"` so they never leak into the public API. Referencing the TS
files directly guarantees the codec cannot drift from the canonical contract.

To add a wire-representable event: edit the shared `.proto` in the TS package (a cross-SDK
coordinated change), then add the mapper case. There is no separate .NET schema to keep in sync.

## 7. Content negotiation parity

`AGUIResults.Negotiate` (server) reproduces `@ag-ui/encoder`'s `preferredMediaTypes(accept,
[proto])`:

- Protobuf is chosen **only** when `application/vnd.ag-ui.event+proto` is *explicitly* in `Accept`
  with non-zero quality and a matching formatter is registered.
- Otherwise SSE is used when `text/event-stream`, a wildcard (`*/*`, `text/*`), or no `Accept` is
  acceptable.
- Otherwise `406 Not Acceptable`.

Client side: `AGUIEventStreamHandler` advertises all formatter media types in `Accept` (order =
preference), then `CanRead` selects the decoder from the response `Content-Type`. SSE's `CanRead`
also accepts a null/empty content type so a server that omits `Content-Type` still decodes.

## 8. Adding a new encoding

1. Implement `IAGUIEventStreamFormatter` in a new package that references only `AGUI.Abstractions`
   + `AGUI.Formatting` (plus any codec dependency). Pick a unique `MediaType`.
2. Implement `CanRead` for that media type; implement `ReadAsync`/`WriteAsync` over the raw stream.
3. Register the formatter as an `IAGUIEventStreamFormatter` on the server (for example,
   `services.AddSingleton<IAGUIEventStreamFormatter, XxxEventStreamFormatter>()`); on the client,
   pass it to `AGUIEventStreamHandler` and wire that handler into the `HttpClient`. The SDK ships no
   DI/builder sugar for transports.
4. If the server negotiation must prefer it explicitly (like proto), extend the negotiation logic;
   otherwise registration order handles preference.
5. Add cross-language parity coverage if the encoding is shared with another SDK.

## 9. Native AOT / trim constraints

- The package multi-targets `net10/9/8/netstandard2.0/net472`; `Directory.Build.props` treats
  warnings as errors and enables nullable. Use `#if NET` / `#if NET7_0_OR_GREATER` for APIs missing
  on `netstandard2.0`/`net472` (e.g. `ArgumentNullException.ThrowIfNull`, `Stream.ReadAsync(Memory)`,
  `request.Options`).
- SSE/JSON paths serialize exclusively through the source-generated `AGUIJsonSerializerContext` —
  never `JsonSerializer.Serialize<object>` or reflection-based serialization.
- Protobuf dynamic JSON goes **only** through `ProtoValueConverter`. Google.Protobuf's
  `JsonFormatter`, `JsonParser`, and descriptor reflection APIs pull in reflection and are not
  trim/AOT safe — they are banned in this package.
