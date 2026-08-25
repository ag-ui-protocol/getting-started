import { describe, it, expect } from "vitest";
import * as proto from "@ag-ui/proto";
import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";
import { protobufFixtures } from "../fixtures/protobuf-events";

// Cross-language protobuf wire-compatibility suite.
//
// The C# CrossLanguage.TestServer exposes three routes backed by the .NET
// `AGUIProtobuf` codec (see ProtobufParityRoute.cs):
//   POST /protobuf/encode        : AG-UI event JSON      -> raw proto message bytes
//   POST /protobuf/decode        : raw proto message bytes -> AG-UI event JSON
//   POST /protobuf/decode-framed : 4-byte BE framed bytes -> AG-UI event JSON array
//
// For every supported event we prove ROUND-TRIP SEMANTIC EQUIVALENCE in both
// directions against `@ag-ui/proto`, which is the real interop guarantee, and
// additionally assert strict byte parity for scalar-only events (where it is
// deterministic). The canonical reference for an event is what the TypeScript
// codec itself produces when decoding its own encoded bytes
// (`proto.decode(proto.encode(event))`) — i.e. the EventSchemas-normalised
// form both SDKs must agree on for the same wire bytes.

function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function netEncode(event: BaseEvent): Promise<Uint8Array> {
  const res = await fetch(`${baseUrl()}/protobuf/encode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    throw new Error(`/protobuf/encode failed: ${res.status} ${await res.text()}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function netDecode(bytes: Uint8Array): Promise<BaseEvent> {
  const res = await fetch(`${baseUrl()}/protobuf/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: toBody(bytes),
  });
  if (!res.ok) {
    throw new Error(`/protobuf/decode failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as BaseEvent;
}

async function netDecodeFramed(framed: Uint8Array): Promise<BaseEvent[]> {
  const res = await fetch(`${baseUrl()}/protobuf/decode-framed`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: toBody(framed),
  });
  if (!res.ok) {
    throw new Error(`/protobuf/decode-framed failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as BaseEvent[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

describe("protobuf wire compatibility: .NET AGUIProtobuf <-> TS @ag-ui/proto", () => {
  for (const fixture of protobufFixtures) {
    describe(fixture.name, () => {
      // The TS canonical reference: same bytes decoded by the TS codec.
      const tsBytes = proto.encode(fixture.event);
      const reference = proto.decode(tsBytes);

      it("TS encode -> .NET decode produces the equivalent event", async () => {
        const decoded = await netDecode(tsBytes);
        expect(decoded).toEqual(reference);
      });

      it(".NET encode -> TS decode produces the equivalent event", async () => {
        const netBytes = await netEncode(fixture.event);
        const tsFromNet = proto.decode(netBytes);
        expect(tsFromNet).toEqual(reference);
      });

      it("byte parity between TS and .NET encoders", async () => {
        const netBytes = await netEncode(fixture.event);
        const matched = bytesEqual(tsBytes, netBytes);

        if (fixture.byteParity === "strict") {
          // Scalar-only events: both encoders emit identical wire bytes.
          expect(matched).toBe(true);
        } else {
          // Struct/object payloads: `google.protobuf.Struct` is a
          // `map<string, Value>` whose entry ordering is not canonical across
          // encoders, so byte equality is not guaranteed. Round-trip
          // equivalence (asserted above) is the real guarantee here; we only
          // record whether the bytes happened to match.
          console.error(
            `[byte-parity][${fixture.name}] strict byte equality ${
              matched ? "HELD" : "did NOT hold (expected: Struct map ordering is non-canonical)"
            } (TS=${tsBytes.length}B, .NET=${netBytes.length}B)`,
          );
          expect(decodeBoth(tsBytes, netBytes)).toBe(true);
        }
      });
    });
  }
});

// Helper used by the roundtrip byte-parity branch: assert that, regardless of
// byte ordering, both encoders' bytes decode (via the TS codec) to the same
// event. This keeps the "do not fail on byte differences" rule while still
// guarding against silent wire corruption.
function decodeBoth(tsBytes: Uint8Array, netBytes: Uint8Array): boolean {
  const fromTs = JSON.stringify(proto.decode(tsBytes));
  const fromNet = JSON.stringify(proto.decode(netBytes));
  return fromTs === fromNet;
}

describe("protobuf framing interop: TS encodeProtobuf (4-byte BE prefix) -> .NET ReadFramedAsync", () => {
  it("decodes a stream of framed events produced by the TS encoder", async () => {
    const encoder = new EventEncoder();

    // Build a concatenated framed stream from several fixtures, exactly the way
    // @ag-ui/encoder writes events on the wire (each: 4-byte BE length + message).
    const sample = protobufFixtures.filter((f) =>
      ["RUN_STARTED", "TEXT_MESSAGE_CONTENT", "STATE_SNAPSHOT (nested object)", "RUN_ERROR"].includes(
        f.name,
      ),
    );

    const frames = sample.map((f) => encoder.encodeProtobuf(f.event));
    const total = frames.reduce((n, f) => n + f.length, 0);
    const stream = new Uint8Array(total);
    let offset = 0;
    for (const frame of frames) {
      stream.set(frame, offset);
      offset += frame.length;
    }

    const decoded = await netDecodeFramed(stream);

    expect(decoded.map((e) => e.type)).toEqual(sample.map((f) => f.event.type));

    // Each decoded event must match the TS canonical reference for that fixture.
    for (let i = 0; i < sample.length; i++) {
      const reference = proto.decode(proto.encode(sample[i]!.event));
      expect(decoded[i]).toEqual(reference);
    }
  });
});
