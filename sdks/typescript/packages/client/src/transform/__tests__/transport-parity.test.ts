import { Subject, firstValueFrom, toArray } from "rxjs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseEvent } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";
import { transformHttpEventStream } from "../http";
import { enforceEvents } from "../../enforce";
import { verifyEvents } from "../../verify";
import { HttpEvent, HttpEventType } from "../../run/http-request";

// Real encoding, not a stub: the point of these tests is what the wire does.
vi.unmock("@ag-ui/proto");

/**
 * The two transports must be interchangeable.
 *
 * Turning bytes into events is transport work; deciding what an event MEANS is
 * the pipeline's, and the pipeline is shared. A reader that also validates makes
 * its transport strictly harsher than the other, so the same stream succeeds
 * over SSE and fails over protobuf — a producer's choice of content type would
 * decide whether a run survives.
 *
 * Each case drives one logical event through both readers and the same
 * downstream stages, then asserts the two agree, rather than asserting either
 * one in isolation.
 */
const RUN_STARTED = { type: "RUN_STARTED", threadId: "t1", runId: "r1" };

const pipeline = (chunk$: Subject<HttpEvent>) =>
  firstValueFrom(
    transformHttpEventStream(chunk$).pipe(enforceEvents(), verifyEvents(), toArray()),
  );

const readOverSSE = (events: unknown[]): Promise<BaseEvent[]> => {
  const chunk$ = new Subject<HttpEvent>();
  const headers = new Headers();
  headers.append("Content-Type", "text/event-stream");
  const done = pipeline(chunk$);
  chunk$.next({ type: HttpEventType.HEADERS, status: 200, headers });
  for (const event of events) {
    chunk$.next({
      type: HttpEventType.DATA,
      data: new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    });
  }
  chunk$.complete();
  return done;
};

const frame = (body: Uint8Array): Uint8Array => {
  const framed = new Uint8Array(4 + body.length);
  new DataView(framed.buffer).setUint32(0, body.length, false);
  framed.set(body, 4);
  return framed;
};

/** Each body is framed separately; pass one array entry per DATA chunk. */
const readOverProto = (bodies: Uint8Array[]): Promise<BaseEvent[]> => {
  const chunk$ = new Subject<HttpEvent>();
  const headers = new Headers();
  headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);
  const done = pipeline(chunk$);
  chunk$.next({ type: HttpEventType.HEADERS, status: 200, headers });
  for (const body of bodies) {
    chunk$.next({ type: HttpEventType.DATA, data: frame(body) });
  }
  chunk$.complete();
  return done;
};

const encodeAll = (events: unknown[]): Uint8Array[] =>
  events.map((event) => proto.encode(event as BaseEvent));

const bothTransports = async (events: unknown[]) => ({
  sse: await readOverSSE(events),
  binary: await readOverProto(encodeAll(events)),
});

/**
 * Runs one lane with console.warn captured.
 *
 * Comparing only the events cannot see this file's failure mode in its
 * quietest form. A reader that drops material BEFORE enforcement gets there
 * produces the same events as one that hands the material on — enforcement
 * would have removed it either way — while the operator loses the one line
 * that said a message, a part or a patch operation went missing. So the
 * warnings are the second half of parity, not decoration.
 */
const watch = async <T>(
  run: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> => {
  const warnings: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  });
  try {
    return { value: await run(), warnings };
  } finally {
    spy.mockRestore();
  }
};

/**
 * The paths enforcement named as stripped, in order.
 *
 * Only enforcement's warnings, deliberately: it is the one stage both
 * transports share, so what it names is directly comparable. A lane may warn
 * about other things on the way — the encoder says so when it is handed an
 * event the schema rejects — and that is not part of this comparison.
 */
const strippedPaths = (warnings: string[]): string[] =>
  warnings
    .map((warning) => /Removed unrecognised material at '([^']*)'/.exec(warning)?.[1])
    .filter((path): path is string => path !== undefined);

/** Both lanes, each watched. `binaryBodies` overrides what the binary lane reads. */
const bothTransportsWatched = async (events: unknown[], binaryBodies?: Uint8Array[]) => {
  const sse = await watch(() => readOverSSE(events));
  const binary = await watch(() =>
    readOverProto(binaryBodies ?? encodeAll(events)),
  );
  return {
    sse: sse.value,
    binary: binary.value,
    sseStripped: strippedPaths(sse.warnings),
    binaryStripped: strippedPaths(binary.warnings),
    sseWarnings: sse.warnings,
    binaryWarnings: binary.warnings,
  };
};

// Frames our own encoder cannot produce, written as a differently-versioned
// producer's encoder would write them. Field numbers come from events.proto:
// Event.run_finished = 13, Event.messages_snapshot = 9.
const HAND_BUILT = {
  // An envelope arm far outside the oneof this build knows: field 908,
  // length-delimited, carrying a base_event whose type is one this build has
  // no name for. An event type from a later protocol, shaped as a later
  // producer's encoder would actually write it.
  futureEvent: new Uint8Array([0xe2, 0x38, 0x04, 0x0a, 0x02, 0x08, 0x1f]),
  // The same arm with an empty payload. Still an event this build cannot name,
  // and still dropped: an empty message is valid protobuf, and what an arm we
  // were never compiled against ought to contain is not ours to say.
  futureEventEmpty: new Uint8Array([0xe2, 0x38, 0x00]),
  // MESSAGES_SNAPSHOT with its required messages list omitted. Our own encoder
  // refuses to write this, which is itself the point: only a defective producer
  // emits it, and the wire cannot tell the omission from an empty list.
  snapshotWithoutMessages: new Uint8Array([0x4a, 0x04, 0x0a, 0x02, 0x08, 0x08]),
  // MESSAGES_SNAPSHOT whose one image part omits its required source entirely.
  contentPartWithoutSource: new Uint8Array([
    0x4a, 0x13, 0x0a, 0x02, 0x08, 0x08, 0x12, 0x0d, 0x0a, 0x01, 0x6d, 0x12, 0x04, 0x75, 0x73,
    0x65, 0x72, 0x42, 0x02, 0x12, 0x00,
  ]),
  // The same snapshot whose one image part carries a source kind from a later
  // protocol — the future arm is one level deeper than the part itself.
  futureContentSource: new Uint8Array([
    0x4a, 0x17, 0x0a, 0x02, 0x08, 0x08, 0x12, 0x11, 0x0a, 0x01, 0x6d, 0x12, 0x04, 0x75, 0x73,
    0x65, 0x72, 0x42, 0x06, 0x12, 0x04, 0x0a, 0x02, 0x1a, 0x00,
  ]),
  // RUN_FINISHED whose flattened outcome is "success" while the sibling
  // interrupts array is populated — a pairing the encoder never writes. This
  // frame carries threadId "t" and runId "r", so its run must be opened with
  // the same ids.
  successCarryingInterrupts: new Uint8Array([
    0x6a, 0x1b, 0x0a, 0x02, 0x08, 0x0c, 0x12, 0x01, 0x74, 0x1a, 0x01, 0x72, 0x2a, 0x07, 0x73,
    0x75, 0x63, 0x63, 0x65, 0x73, 0x73, 0x32, 0x06, 0x0a, 0x01, 0x69, 0x12, 0x01, 0x78,
  ]),
  // MESSAGES_SNAPSHOT carrying a user message whose single content part sets
  // no arm this build knows: a media kind added after it shipped.
  futureContentPart: new Uint8Array([
    0x4a, 0x13, 0x0a, 0x02, 0x08, 0x08, 0x12, 0x0d, 0x0a, 0x01, 0x6d, 0x12, 0x04, 0x75, 0x73,
    0x65, 0x72, 0x42, 0x02, 0x32, 0x00,
  ]),
};

const DECODE_FAILURE = /Failed to decode protocol buffer message/;

describe("transport parity", () => {
  // The case that motivated all of this: an outcome added after this build
  // shipped. Enforcement strips it on both paths — what matters is that neither
  // reader decided the question for itself on the way in.
  it("agrees on an outcome neither build recognises", async () => {
    const { sse, binary } = await bothTransports([
      RUN_STARTED,
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1", outcome: { type: "cancelled" } },
    ]);

    expect(binary).toEqual(sse);
    expect(sse[1]).not.toHaveProperty("outcome");
  });

  it("agrees on an outcome both builds recognise", async () => {
    const { sse, binary } = await bothTransports([
      RUN_STARTED,
      {
        type: "RUN_FINISHED",
        threadId: "t1",
        runId: "r1",
        outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "why" }] },
      },
    ]);

    expect(binary).toEqual(sse);
    expect(sse[1]).toHaveProperty("outcome.type", "interrupt");
  });

  // Payload belonging to a different case. The wire can express it because the
  // outcome is flattened; JSON can express it as an undescribed property on a
  // closed object. Both readings must reach enforcement and be stripped there.
  it("agrees on an outcome carrying payload from another case", async () => {
    const started = { type: "RUN_STARTED", threadId: "t", runId: "r" };
    const sse = await readOverSSE([
      started,
      {
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "r",
        outcome: { type: "success", interrupts: [{ id: "i", reason: "x" }] },
      },
    ]);
    const binary = await readOverProto([
      ...encodeAll([started]),
      HAND_BUILT.successCarryingInterrupts,
    ]);

    expect(binary).toEqual(sse);
    expect(sse[1]).toHaveProperty("outcome", { type: "success" });
  });

  // A media kind from a later protocol. Stripped from its array on both paths;
  // it must not take the message carrying it down with it.
  it("agrees on a content part neither build recognises", async () => {
    const sse = await readOverSSE([
      RUN_STARTED,
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "m", role: "user", content: [{ type: "future_part" }] }],
      },
    ]);
    const binary = await readOverProto([
      ...encodeAll([RUN_STARTED]),
      HAND_BUILT.futureContentPart,
    ]);

    expect(binary).toEqual(sse);
    expect(sse[1]).toHaveProperty("messages.0.content", []);
  });

  // One level deeper than the case above: the part is a kind this build knows,
  // but its source is not. The source is required, so the drop has to cascade
  // and take the whole part — emitting a sourceless image would hand
  // enforcement something the schema calls malformed.
  it("agrees on a content source neither build recognises", async () => {
    const sse = await readOverSSE([
      RUN_STARTED,
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [
          {
            id: "m",
            role: "user",
            content: [{ type: "image", source: { type: "future_source" } }],
          },
        ],
      },
    ]);
    const binary = await readOverProto([
      ...encodeAll([RUN_STARTED]),
      HAND_BUILT.futureContentSource,
    ]);

    expect(binary).toEqual(sse);
    expect(sse[1]).toHaveProperty("messages.0.content", []);
  });

  // The other half of that judgement, and the reason the guard tests presence
  // rather than readability alone: a source the producer OMITTED is a required
  // field missing, which is malformed on both transports. Dropping the part for
  // that would hide on binary a defect the JSON path reports.
  it("agrees that a content part with no source at all is fatal", async () => {
    await expect(
      readOverSSE([
        RUN_STARTED,
        {
          type: "MESSAGES_SNAPSHOT",
          messages: [{ id: "m", role: "user", content: [{ type: "image" }] }],
        },
      ]),
    ).rejects.toThrow();

    await expect(
      readOverProto([...encodeAll([RUN_STARTED]), HAND_BUILT.contentPartWithoutSource]),
    ).rejects.toThrow();
  });

  // JSON Patch may grow operations too. An op added after this build shipped is
  // an unrecognised union member on both transports, so both drop it from the
  // patch and keep the rest of the run.
  it("agrees on a patch operation neither build recognises", async () => {
    const sse = await readOverSSE([
      RUN_STARTED,
      { type: "STATE_DELTA", delta: [{ op: "increment", path: "/x" }] },
    ]);
    // STATE_DELTA carrying one operation whose enum value is 99.
    const binary = await readOverProto([
      ...encodeAll([RUN_STARTED]),
      new Uint8Array([0x42, 0x0c, 0x0a, 0x02, 0x08, 0x07, 0x12, 0x06, 0x08, 0x63, 0x12, 0x02, 0x2f, 0x78]),
    ]);

    expect(binary).toEqual(sse);
    expect(sse[1]).toHaveProperty("delta", []);
  });

  // A role from a later protocol makes the whole message an unrecognised
  // member of the Message union, so it leaves the array on both transports.
  // A role this build DOES know carrying the wrong content shape stays fatal
  // on both, which is a different question and not this one.
  it("agrees on a message role neither build recognises", async () => {
    const event = {
      type: "MESSAGES_SNAPSHOT",
      messages: [{ id: "m", role: "future", content: [{ type: "text", text: "hi" }] }],
    };
    const { sse, binary } = await bothTransports([RUN_STARTED, event]);

    expect(binary).toEqual(sse);
    expect(sse[1]).toHaveProperty("messages", []);
  });

  // Our own encoder has no envelope arm for an event type it does not know, so
  // the binary half is hand-built as a newer producer's encoder would write it.
  it("agrees on an event type neither build knows", async () => {
    const sse = await readOverSSE([
      RUN_STARTED,
      { type: "SOMETHING_NEW", detail: "from a later protocol" },
    ]);
    const binary = await readOverProto([
      ...encodeAll([RUN_STARTED]),
      HAND_BUILT.futureEvent,
    ]);

    expect(binary).toEqual(sse);
    expect(sse).toHaveLength(1);

    expect(
      await readOverProto([...encodeAll([RUN_STARTED]), HAND_BUILT.futureEventEmpty]),
    ).toEqual(binary);
  });

  // Malformed is fatal on both — and fatal at the SAME stage. Asserting only
  // that each rejects would pass with the reader validating again, since it
  // would simply throw earlier; the point is that the verdict comes from
  // enforcement, so the binary failure must not be a decode failure.
  it("agrees that a missing required field is fatal, at enforcement", async () => {
    const malformed = [RUN_STARTED, { type: "CUSTOM", name: "heartbeat" }];

    await expect(readOverSSE(malformed)).rejects.toThrow();
    await expect(readOverProto(encodeAll(malformed))).rejects.toThrow();
    await expect(readOverProto(encodeAll(malformed))).rejects.not.toThrow(DECODE_FAILURE);
  });

  // Bytes that encode no event are not a message from the future, and must stay
  // fatal rather than being skipped as one — skipping them would silently
  // swallow a real event.
  it("keeps malformed bytes fatal over the binary transport", async () => {
    const fatal: Record<string, number[]> = {
      // An empty envelope names nothing at all.
      "empty envelope": [],
      // Field 908 as a varint. Every arm is length-delimited, so this is no arm.
      "future tag, wrong wire type": [0xe0, 0x38, 0x01],
      // Field 908 length-delimited, but its payload is an unterminated varint:
      // bytes that encode no message, so not an event to learn about later.
      "future arm, unwalkable payload": [0xe2, 0x38, 0x01, 0x80],
      // A group closing with a different field number than it opened with.
      "future arm, mismatched groups": [0xe2, 0x38, 0x02, 0x0b, 0x14],
      // An eleven-byte varint. A conformant encoder never writes one.
      "future arm, overlong varint": [
        0xe2, 0x38, 0x0c, 0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00,
      ],
      // The same two rules one level out, beside a future arm rather than
      // inside one. The envelope and an arm's payload are walked by different
      // code, so each rule needs pinning in both places or they drift apart.
      "envelope, mismatched groups": [0xa3, 0x06, 0xac, 0x06, 0xe2, 0x38, 0x00],
      // A tag whose field number overflows uint32. Masking the overflow bits
      // would turn it into a smaller, plausible field number — here, 900.
      "envelope, tag overflows uint32": [0xa2, 0xb8, 0x80, 0x80, 0x10, 0x00],
      // A length of 2^32 inside a future arm, with no payload behind it.
      "future arm, length overflows uint32": [
        0xe2, 0x38, 0x06, 0x0a, 0x80, 0x80, 0x80, 0x80, 0x10,
      ],
      // A known arm opening a group. The group numbers match, so the balance
      // check passes; what makes it broken is that no envelope arm uses that
      // wire type. Paired with a future arm, since alone it already failed.
      "envelope, known tag as a group": [0x0b, 0x0c, 0xe2, 0x38, 0x00],
      // Ten bytes is the varint limit, but the tenth may only set bit 0 —
      // 0x02 there encodes a value no protobuf scalar can hold.
      "future arm, ten-byte varint overflow": [
        0xe2, 0x38, 0x0b, 0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02,
      ],
      "envelope, overlong varint": [
        0xe2, 0x38, 0x00, 0xe8, 0x38, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
        0x00,
      ],
    };

    for (const [name, bytes] of Object.entries(fatal)) {
      await expect(
        readOverProto([new Uint8Array(bytes)]),
        `expected ${name} to stay fatal`,
      ).rejects.toThrow();
    }
  });

  // Protobuf ignores fields a reader does not know, and this envelope is no
  // exception: a later version may add fields beside the arms, so a frame
  // carrying one must still yield the event it does name. Rejecting here would
  // break every older reader the moment such a field shipped — the same
  // failure this file exists to prevent, pointed the other way.
  it("still reads a known arm carried alongside an unknown field", async () => {
    const known = proto.encode(RUN_STARTED as BaseEvent);
    const mixed = new Uint8Array(known.length + HAND_BUILT.futureEvent.length);
    mixed.set(known);
    mixed.set(HAND_BUILT.futureEvent, known.length);

    expect(await readOverProto([mixed])).toEqual([RUN_STARTED]);
  });

  // Dropping a frame must advance past it, or the reader re-reads it forever.
  // Both frames ride in ONE chunk so the drop and the following read happen in
  // a single pass of the buffer loop.
  it("keeps reading after dropping a frame it cannot name", async () => {
    const chunk$ = new Subject<HttpEvent>();
    const headers = new Headers();
    headers.append("Content-Type", proto.AGUI_MEDIA_TYPE);
    const done = pipeline(chunk$);
    chunk$.next({ type: HttpEventType.HEADERS, status: 200, headers });

    const dropped = frame(HAND_BUILT.futureEvent);
    const valid = frame(proto.encode(RUN_STARTED as BaseEvent));
    const together = new Uint8Array(dropped.length + valid.length);
    together.set(dropped);
    together.set(valid, dropped.length);
    chunk$.next({ type: HttpEventType.DATA, data: together });
    chunk$.complete();

    expect(await done).toEqual([RUN_STARTED]);
  });

  // The line the reader holds is well-formed protobuf, never conformance to a
  // schema. Field numbers 19000-19999 are reserved by convention and no real
  // schema declares one, but such a frame IS protobuf — and judging what an arm
  // this build was never compiled against may contain is how a reader ends up
  // rejecting the future events it exists to survive.
  it("drops a future arm on a field number protobuf reserves", async () => {
    const reserved = new Uint8Array([0xc2, 0xa3, 0x09, 0x00]);

    expect(await readOverProto([...encodeAll([RUN_STARTED]), reserved])).toEqual([RUN_STARTED]);
  });

  // A divergence the binary encoding cannot close, pinned so it cannot widen
  // or vanish unnoticed. protobuf gives no presence to a required scalar, so an
  // omitted required string arrives as "" and is accepted where the same JSON
  // is rejected as malformed. The schema forbids omitting it either way, so
  // this changes how a defective producer is diagnosed, not what a conformant
  // one may send.
  it("cannot agree about an omitted required scalar", async () => {
    const omitted = [
      RUN_STARTED,
      { type: "TEXT_MESSAGE_START", role: "assistant" },
      { type: "TEXT_MESSAGE_END" },
    ];

    await expect(readOverSSE(omitted)).rejects.toThrow(/messageId/);

    const binary = await readOverProto(encodeAll(omitted));
    expect(binary[1]).toHaveProperty("messageId", "");
  });

  // The same gap, and the reason the spec names presence rather than scalars:
  // a required list has none either, so an omitted one arrives empty.
  it("cannot agree about an omitted required list", async () => {
    await expect(readOverSSE([RUN_STARTED, { type: "MESSAGES_SNAPSHOT" }])).rejects.toThrow(
      /messages/,
    );

    const binary = await readOverProto([
      ...encodeAll([RUN_STARTED]),
      HAND_BUILT.snapshotWithoutMessages,
    ]);
    expect(binary[1]).toHaveProperty("messages", []);
  });
});

/**
 * The other half of interchangeability: the two transports must lose the same
 * material AND say so the same way.
 *
 * Enforcement is the one stage both share, and it names what it strips. A
 * reader that quietly removes a message, a content part or a patch operation
 * on the way in reaches enforcement with a clean event, so nothing is warned
 * about at all — the events still match, and an operator watching the binary
 * lane sees a silent hole where the text lane printed a line.
 */
describe("transport parity: what each transport says it dropped", () => {
  const cleared: string | undefined = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  beforeEach(() => {
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  });
  afterEach(() => {
    if (cleared !== undefined) process.env.SUPPRESS_TRANSFORMATION_WARNINGS = cleared;
  });

  it("names the same dropped message for a role neither build recognises", async () => {
    const { sse, binary, sseStripped, binaryStripped } = await bothTransportsWatched([
      RUN_STARTED,
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [
          { id: "m0", role: "user", content: [{ type: "text", text: "hi" }] },
          { id: "m1", role: "oracle", content: [{ type: "text", text: "hi" }] },
        ],
      },
    ]);

    expect(binary).toEqual(sse);
    expect(sseStripped).toEqual(["/messages/1"]);
    expect(binaryStripped).toEqual(sseStripped);
  });

  it("names the same dropped operation for a patch op neither build recognises", async () => {
    // STATE_DELTA carrying one operation whose enum value is 99.
    const { sse, binary, sseStripped, binaryStripped } = await bothTransportsWatched(
      [RUN_STARTED, { type: "STATE_DELTA", delta: [{ op: "increment", path: "/x" }] }],
      [
        ...encodeAll([RUN_STARTED]),
        new Uint8Array([0x42, 0x0c, 0x0a, 0x02, 0x08, 0x07, 0x12, 0x06, 0x08, 0x63, 0x12, 0x02, 0x2f, 0x78]),
      ],
    );

    expect(binary).toEqual(sse);
    expect(sseStripped).toEqual(["/delta/0"]);
    expect(binaryStripped).toEqual(sseStripped);
  });

  /**
   * The one drop the binary reader cannot hand on, and so the one warning that
   * cannot match word for word.
   *
   * An unrecognised ROLE or patch OP still has a name — the string arrived on
   * the wire — so the reader passes it to enforcement and enforcement names the
   * path. An unset protobuf oneof has no name at all: the bytes say only that
   * no arm this build knows was populated. There is nothing to hand on, so the
   * drop stays in the reader, and the reader has to say so itself — the same
   * answer this SDK already gives for an envelope arm it cannot name.
   */
  it("warns on both lanes for a content part neither build recognises", async () => {
    const { sse, binary, sseStripped, binaryStripped, binaryWarnings } =
      await bothTransportsWatched(
        [
          RUN_STARTED,
          {
            type: "MESSAGES_SNAPSHOT",
            messages: [{ id: "m", role: "user", content: [{ type: "future_part" }] }],
          },
        ],
        [...encodeAll([RUN_STARTED]), HAND_BUILT.futureContentPart],
      );

    expect(binary).toEqual(sse);
    expect(sseStripped).toEqual(["/messages/0/content/0"]);
    // No path to name, but never silent.
    expect(binaryStripped).toEqual([]);
    expect(binaryWarnings.join("\n")).toMatch(/content part this build does not know/);
  });

  it("warns on both lanes for a content source neither build recognises", async () => {
    const { sse, binary, sseStripped, binaryWarnings } = await bothTransportsWatched(
      [
        RUN_STARTED,
        {
          type: "MESSAGES_SNAPSHOT",
          messages: [
            { id: "m", role: "user", content: [{ type: "image", source: { type: "future_source" } }] },
          ],
        },
      ],
      [...encodeAll([RUN_STARTED]), HAND_BUILT.futureContentSource],
    );

    expect(binary).toEqual(sse);
    expect(sseStripped).toEqual(["/messages/0/content/0"]);
    expect(binaryWarnings.join("\n")).toMatch(/content part this build does not know/);
  });
});
