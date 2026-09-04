import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import * as protoEvents from "../src/generated/events";
import * as protoTypes from "../src/generated/types";
import * as protoPatch from "../src/generated/patch";
import { decode, encode } from "../src/proto";

/**
 * The fixture corpus is the behavioural contract, and the binary transport
 * must carry the same protocol as the JSON path: every valid event fixture
 * round-trips through encode/decode to the same materialised event, absent
 * fields staying absent. Events the handwritten SDK does not know yet ride
 * structurally and must round-trip byte-true as well.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "spec", "draft", "fixtures");
const BYTES_DIR = join(HERE, "__fixtures__", "bytes");

const KNOWN_TO_CORE = new Set<string>(Object.values(EventType));

interface Case {
  name: string;
  document: Record<string, unknown>;
}

const cases: Case[] = [];
for (const anchor of readdirSync(FIXTURES_DIR).sort()) {
  // Every event definition is named ...Event, and nothing else is.
  if (!anchor.endsWith("Event")) continue;
  const dir = join(FIXTURES_DIR, anchor, "valid");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json") || file.endsWith(".expect.json")) continue;
    cases.push({
      name: `${anchor}/${file}`,
      document: JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>,
    });
  }
}

/**
 * Recorded wire normalisations: the binary transport cannot tell an absent
 * repeated field from an empty one, so decode materialises the optional
 * RunAgentInput arrays as present-and-empty — the one form every layer
 * accepts. The JSON path now agrees for `tools` and `context`: the schema
 * still leaves them optional, and the generated TypeScript materialises them,
 * so both transports hand a consumer a list either way. `resume` is normalised
 * here too and is NOT materialised on the JSON path, so it remains a genuine
 * divergence between the transports rather than a recorded agreement.
 */
const BINARY_NORMALISED: Record<
  string,
  ((document: Record<string, unknown>) => unknown) | undefined
> = {
  "RunStartedEvent/with-input.json": (document) => ({
    ...document,
    input: {
      ...(document.input as Record<string, unknown>),
      tools: [],
      context: [],
      resume: [],
    },
  }),
};

/** No own key anywhere may hold undefined: absent means absent. */
function expectNoUndefinedKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoUndefinedKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    expect(entry, `${path}.${key} is an undefined-valued key`).not.toBe(undefined);
    expectNoUndefinedKeys(entry, `${path}.${key}`);
  }
}

/** What the JSON path materialises: validated where the SDK knows the type. */
function materialise(document: Record<string, unknown>): unknown {
  return KNOWN_TO_CORE.has(document.type as string) ? EventSchemas.parse(document) : document;
}

describe("every valid event fixture round-trips over the binary transport", () => {
  it("covers all 31 event types", () => {
    // A deleted fixture directory must not silently shrink the corpus.
    const covered = new Set(cases.map((entry) => entry.document.type));
    const declared = Object.values(EventType);
    expect(declared.filter((value) => !covered.has(value))).toEqual([]);
    expect(covered.size).toBe(31);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (name, entry) => {
    const normalise = BINARY_NORMALISED[name];
    if (normalise) {
      const decoded = decode(encode(materialise(entry.document) as never));
      expect(decoded).toEqual(normalise(entry.document));
      expectNoUndefinedKeys(decoded);
      return;
    }
    const expected = materialise(entry.document);
    const decoded = decode(encode(expected as never));
    expect(decoded).toEqual(expected);
    // toEqual cannot see undefined-valued keys, so absent-stays-absent gets
    // its own gate.
    expectNoUndefinedKeys(decoded);
  });
});

describe("byte fixtures", () => {
  // Committed bytes are the cross-runtime target: the .NET runtime proves
  // itself by reading bytes TypeScript wrote (and vice versa). Regenerate
  // with WRITE_PROTO_BYTE_FIXTURES=1 when the wire deliberately changes.
  const write = process.env.WRITE_PROTO_BYTE_FIXTURES === "1";

  const byteCases = cases;

  it.each(byteCases.map((entry) => [entry.name, entry] as const))(
    "%s matches its committed bytes",
    (name, entry) => {
      const normalise = BINARY_NORMALISED[name];
      const encodeInput = materialise(entry.document);
      const expected = normalise ? normalise(entry.document) : encodeInput;
      const bytes = encode(encodeInput as never);
      const path = join(BYTES_DIR, `${entry.name.replace(/[/]/g, "__")}.bin`);
      if (write) {
        mkdirSync(BYTES_DIR, { recursive: true });
        writeFileSync(path, bytes);
        return;
      }
      expect(existsSync(path), `${path} missing — run with WRITE_PROTO_BYTE_FIXTURES=1`).toBe(true);
      const committed = new Uint8Array(readFileSync(path));
      expect(Buffer.from(bytes).equals(Buffer.from(committed))).toBe(true);
      expect(decode(committed)).toEqual(expected);
    },
  );

  it("has no stale byte fixtures", () => {
    if (write || !existsSync(BYTES_DIR)) return;
    const expected = new Set(byteCases.map((entry) => `${entry.name.replace(/[/]/g, "__")}.bin`));
    const stale = readdirSync(BYTES_DIR).filter((file) => !expected.has(file));
    expect(stale).toEqual([]);
  });
});

describe(".NET byte fixtures", () => {
  // The other direction of the cross-runtime proof: bytes the .NET runtime
  // committed (AGUI_WRITE_PROTO_BYTE_FIXTURES=1 over the same corpus) must
  // decode here to the same materialised event.
  const DOTNET_BYTES_DIR = join(
    REPO_ROOT,
    "sdks",
    "dotnet",
    "tests",
    "AGUI.Protobuf.UnitTests",
    "Fixtures",
    "bytes-dotnet",
  );

  /**
   * The one recorded .NET-model collapse: a root-level null in an optional
   * any-typed field deserialises to C# null and is never written back, so the
   * .NET bytes legitimately lack it (nulls nested inside any-typed values
   * survive).
   */
  const DOTNET_NORMALISED: Record<
    string,
    ((expected: Record<string, unknown>) => unknown) | undefined
  > = {
    "TextMessageEndEvent/raw-event-null.json": ({ rawEvent: _rawEvent, ...rest }) => rest,
  };

  const dotnetCases = cases;

  it("has committed .NET bytes for the whole corpus", () => {
    const missing = dotnetCases
      .map((entry) => `${entry.name.replace(/[/]/g, "__")}.bin`)
      .filter((file) => !existsSync(join(DOTNET_BYTES_DIR, file)));
    expect(missing).toEqual([]);
  });

  it.each(dotnetCases.map((entry) => [entry.name, entry] as const))(
    "%s decodes from the .NET bytes",
    (name, entry) => {
      const path = join(DOTNET_BYTES_DIR, `${entry.name.replace(/[/]/g, "__")}.bin`);
      if (!existsSync(path)) return; // reported by the completeness gate above
      const normalise = BINARY_NORMALISED[name];
      let expected = normalise ? normalise(entry.document) : materialise(entry.document);
      const dotnetNormalise = DOTNET_NORMALISED[name];
      if (dotnetNormalise) expected = dotnetNormalise(expected as Record<string, unknown>);
      const decoded = decode(new Uint8Array(readFileSync(path)));
      expect(decoded).toEqual(expected);
      expectNoUndefinedKeys(decoded);
    },
  );
});

describe("malformed wire input", () => {
  // The decode guards, each pinned: whatever a hostile or broken producer
  // sends, decode answers with an error, never with a different event than
  // another runtime would surface.
  const wrap = (payload: Record<string, unknown>): Uint8Array =>
    protoEvents.Event.encode(payload as never).finish();

  it("rejects an envelope with no populated entry", () => {
    expect(() => decode(wrap({}))).toThrow();
  });

  it("rejects a payload without a base event", () => {
    expect(() => decode(wrap({ toolCallEnd: { toolCallId: "c1" } }))).toThrow();
  });

  it("rejects an unmappable base event type", () => {
    expect(() =>
      decode(wrap({ toolCallEnd: { baseEvent: { type: 99 }, toolCallId: "c1" } })),
    ).toThrow();
  });

  it("rejects the synthetic UNRECOGNIZED type", () => {
    expect(() =>
      decode(wrap({ toolCallEnd: { baseEvent: { type: -1 }, toolCallId: "c1" } })),
    ).toThrow();
  });

  it("rejects a base event type that disagrees with the envelope entry", () => {
    expect(() =>
      decode(
        wrap({
          stepStarted: {
            baseEvent: { type: protoEvents.EventType.STEP_FINISHED },
            stepName: "plan",
          },
        }),
      ),
    ).toThrow(/envelope carries STEP_STARTED/);
  });

  it("rejects an envelope with more than one populated entry", () => {
    const first = encode({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
    } as never);
    const second = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    const concatenated = new Uint8Array([...first, ...second]);
    expect(() => decode(concatenated)).toThrow();
  });
});

describe("nested duplicate-field guards", () => {
  // Canonical protobuf parsers MERGE a repeated occurrence of a singular
  // message-typed field where ts-proto REPLACES it, so the same malformed
  // bytes would materialise differently across runtimes; the generated scan
  // rejects them in both.
  const framed = (fieldNumber: number, payload: Uint8Array): Uint8Array => {
    const bytes: number[] = [];
    for (const value of [fieldNumber * 8 + 2, payload.length]) {
      let rest = value;
      while (rest >= 0x80) {
        bytes.push((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
      }
      bytes.push(rest);
    }
    return new Uint8Array([...bytes, ...payload]);
  };

  // The StepFinishedEvent envelope entry (field 16 in the freeze).
  const STEP_FINISHED_TAG = 16;

  it("frames a valid event correctly (the doctored tests' positive control)", () => {
    const stepBytes = protoEvents.StepFinishedEvent.encode({
      baseEvent: { type: protoEvents.EventType.STEP_FINISHED },
      stepName: "plan",
    } as never).finish();
    const decoded = decode(framed(STEP_FINISHED_TAG, stepBytes));
    expect(decoded).toEqual({ type: EventType.STEP_FINISHED, stepName: "plan" });
  });

  it("rejects a duplicated base_event inside an event", () => {
    const stepBytes = protoEvents.StepFinishedEvent.encode({
      baseEvent: { type: protoEvents.EventType.STEP_FINISHED },
      stepName: "plan",
    } as never).finish();
    const extraBaseEvent = framed(
      1,
      protoEvents.BaseEvent.encode({
        type: protoEvents.EventType.STEP_FINISHED,
        timestamp: 9,
      } as never).finish(),
    );
    const doctored = framed(STEP_FINISHED_TAG, new Uint8Array([...stepBytes, ...extraBaseEvent]));
    expect(() => decode(doctored)).toThrow(/Invalid event/);
  });

  it("rejects a repeated occurrence of the same content-part arm", () => {
    // text{text:"a"} followed by text{}: canonical parsers keep "a" (merge),
    // ts-proto keeps "" (replace) — reject rather than diverge.
    const arm = (text: Record<string, unknown>): Uint8Array =>
      protoTypes.InputContent.encode({ text } as never).finish();
    const twoOccurrences = new Uint8Array([...arm({ text: "a" }), ...arm({})]);
    const message = protoTypes.Message.encode({
      id: "u1",
      role: "user",
      toolCalls: [],
      contentParts: [],
    } as never).finish();
    const messageWithParts = new Uint8Array([...message, ...framed(8, twoOccurrences)]);
    const snapshot = protoEvents.MessagesSnapshotEvent.encode({
      baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
      messages: [],
    } as never).finish();
    const doctored = framed(9, new Uint8Array([...snapshot, ...framed(2, messageWithParts)]));
    expect(() => decode(doctored)).toThrow(/Invalid event/);
  });
});

describe("content part guards", () => {
  // A part naming no arm this build knows is dropped from its array, not
  // rejected — the same thing enforcement does to an unrecognised union member
  // arriving as JSON. Rejecting made a media kind added after this build
  // shipped fatal over binary and survivable over SSE.
  it("drops a content part with no recognisable arm", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "u1",
            role: "user",
            toolCalls: [],
            contentParts: [{}],
          },
        ],
      },
    } as never).finish();
    const decoded = decode(bytes) as unknown as {
      messages: Array<{ content?: unknown }>;
    };
    expect(decoded.messages[0].content).toEqual([]);
  });
});

describe("content part guards (exclusivity)", () => {
  const message = (fields: Record<string, unknown>): Uint8Array =>
    protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [{ id: "u1", role: "user", toolCalls: [], ...fields }],
      },
    } as never).finish();

  it("rejects string content alongside content parts", () => {
    expect(() =>
      decode(message({ content: "ok", contentParts: [{ text: { text: "hi" } }] })),
    ).toThrow(/both string content and content parts/);
  });

  it("rejects a part carrying more than one arm", () => {
    expect(() =>
      decode(
        message({
          contentParts: [
            {
              text: { text: "hi" },
              image: { source: { url: { value: "u" } } },
            },
          ],
        }),
      ),
    ).toThrow(/Invalid event/);
  });

  it("rejects a source carrying more than one arm", () => {
    expect(() =>
      decode(
        message({
          contentParts: [
            {
              image: {
                source: {
                  url: { value: "u" },
                  data: { value: "d", mimeType: "image/png" },
                },
              },
            },
          ],
        }),
      ),
    ).toThrow(/Invalid event/);
  });
});

describe("flattened outcome guards", () => {
  const wrap = (payload: Record<string, unknown>): Uint8Array =>
    protoEvents.Event.encode(payload as never).finish();
  const base = { type: protoEvents.EventType.RUN_FINISHED };

  // Decoding is transport work: it reconstitutes the JSON an SSE producer would
  // have sent and leaves the judging to enforcement, which is the one stage both
  // transports share. Throwing here instead would make the same stream survive
  // over SSE and fail over binary.
  it("rebuilds an unknown outcome rather than rejecting it", () => {
    const decoded = decode(
      wrap({
        runFinished: {
          baseEvent: base,
          threadId: "t1",
          runId: "r1",
          outcome: "cancelled",
          interrupts: [],
          usage: [],
        },
      }),
    ) as unknown as { outcome?: unknown };

    expect(decoded.outcome).toEqual({ type: "cancelled" });
  });

  // Which payload an unknown case owns is unknowable here, so whatever arrived
  // rides along rather than being silently dropped by the decoder.
  it("carries an unknown outcome's payload through", () => {
    const decoded = decode(
      wrap({
        runFinished: {
          baseEvent: base,
          threadId: "t1",
          runId: "r1",
          outcome: "cancelled",
          interrupts: [{ id: "i1", reason: "r" }],
          usage: [],
        },
      }),
    ) as unknown as { outcome?: { type?: string; interrupts?: unknown[] } };

    expect(decoded.outcome?.type).toBe("cancelled");
    expect(decoded.outcome?.interrupts).toHaveLength(1);
  });

  // Payload belonging to another case is a contradiction, but one the JSON
  // form can express too — there it reads as an undescribed property on a
  // closed object and enforcement strips it. So it is rebuilt as it arrived and
  // judged at the stage both transports share, not decided here for one.
  it("carries a success outcome's foreign payload through to enforcement", () => {
    const decoded = decode(
      wrap({
        runFinished: {
          baseEvent: base,
          threadId: "t1",
          runId: "r1",
          outcome: "success",
          interrupts: [{ id: "i1", reason: "r" }],
          usage: [],
        },
      }),
    ) as unknown as { outcome?: { type?: string; interrupts?: unknown[] } };

    expect(decoded.outcome?.type).toBe("success");
    expect(decoded.outcome?.interrupts).toHaveLength(1);
  });

  // With no outcome the payload belongs nowhere, so it rides at the top level
  // as an undescribed property — which is what a JSON producer's stray
  // property is, and enforcement strips it with a warning.
  it("carries an absent outcome's foreign payload through to enforcement", () => {
    const decoded = decode(
      wrap({
        runFinished: {
          baseEvent: base,
          threadId: "t1",
          runId: "r1",
          outcome: "",
          interrupts: [{ id: "i1", reason: "r" }],
          usage: [],
        },
      }),
    ) as unknown as { outcome?: unknown; interrupts?: unknown[] };

    expect(decoded.outcome).toBeUndefined();
    expect(decoded.interrupts).toHaveLength(1);
  });

  it("rebuilds an unknown subagent outcome rather than rejecting it", () => {
    const decoded = decode(
      wrap({
        subagentFinished: {
          baseEvent: { type: protoEvents.EventType.SUBAGENT_FINISHED },
          subagentRunId: "s1",
          outcome: "cancelled",
          interruptIds: [],
        },
      }),
    ) as unknown as { outcome?: unknown };

    expect(decoded.outcome).toEqual({ type: "cancelled" });
  });

  it("carries an absent subagent outcome's foreign payload through", () => {
    const decoded = decode(
      wrap({
        subagentFinished: {
          baseEvent: { type: protoEvents.EventType.SUBAGENT_FINISHED },
          subagentRunId: "s1",
          outcome: "",
          interruptIds: ["i1"],
        },
      }),
    ) as unknown as { outcome?: unknown; interruptIds?: unknown[] };

    expect(decoded.outcome).toBeUndefined();
    expect(decoded.interruptIds).toEqual(["i1"]);
  });

  it("rejects content parts on a role that has none", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "hi",
            toolCalls: [],
            contentParts: [{ text: { text: "erased" } }],
          },
        ],
      },
    } as never).finish();
    expect(() => decode(bytes)).toThrow(/role that has none/);
  });

  it("rejects activity content on a role that has none", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "hi",
            activityContent: { progress: 1 },
            toolCalls: [],
            contentParts: [],
          },
        ],
      },
    } as never).finish();
    expect(() => decode(bytes)).toThrow(/non-activity role/);
  });

  it("rejects an activity message carrying string content", () => {
    const bytes = protoEvents.Event.encode({
      messagesSnapshot: {
        baseEvent: { type: protoEvents.EventType.MESSAGES_SNAPSHOT },
        messages: [
          {
            id: "a1",
            role: "activity",
            content: "lost",
            activityContent: { progress: 1 },
            toolCalls: [],
            contentParts: [],
          },
        ],
      },
    } as never).finish();
    expect(() => decode(bytes)).toThrow(/other content forms/);
  });

  it("ignores duplicated unknown envelope fields, per protobuf rules", () => {
    const valid = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    // Field 90, length-delimited, empty — twice. Unknown, so ignored.
    const unknown = new Uint8Array([0xd2, 0x05, 0x00, 0xd2, 0x05, 0x00]);
    const extended = new Uint8Array([...valid, ...unknown]);
    expect((decode(extended) as { stepName?: string }).stepName).toBe("plan");
  });

  it.each([99, -1])("carries an out-of-enum patch operation on (%s)", (op) => {
    // 99 reverse-maps to undefined; -1 to ts-proto's synthetic UNRECOGNIZED.
    // Neither may invent an operation, and neither is fatal — and neither is
    // dropped HERE either. An operation added to JSON Patch after this build
    // shipped reaches the SSE reader as an unrecognised union member, and
    // enforcement removes it from the array and NAMES the path it removed.
    // Removing it in the decoder removed it just as surely but said nothing,
    // so the same patch lost an operation loudly over SSE and silently over
    // binary — the split this layer exists to prevent, pointed at the warning
    // rather than at the event.
    //
    // The enum value is all the wire carries for an op this build cannot name,
    // so it rides on as its own decimal spelling. That is not a valid JSON
    // Patch op either, which is the point: enforcement reads it as the
    // unrecognised union member it is and strips the operation, saying so.
    const bytes = protoEvents.Event.encode({
      stateDelta: {
        baseEvent: { type: protoEvents.EventType.STATE_DELTA },
        delta: [{ op, path: "/x" }],
      },
    } as never).finish();
    expect((decode(bytes) as unknown as { delta: unknown[] }).delta).toEqual([
      { op: String(op), path: "/x" },
    ]);
  });

  it("keeps the operations it can name beside one it cannot", () => {
    const bytes = protoEvents.Event.encode({
      stateDelta: {
        baseEvent: { type: protoEvents.EventType.STATE_DELTA },
        delta: [
          { op: 99, path: "/x" },
          { op: protoPatch.JsonPatchOperationType.REPLACE, path: "/y", value: undefined },
        ],
      },
    } as never).finish();
    const delta = (decode(bytes) as unknown as { delta: Array<{ op?: string; path?: string }> })
      .delta;
    // Both survive the decoder: the one it can name spelled as the schema
    // spells it, the one it cannot spelled as the wire carried it. Enforcement
    // is the stage that tells them apart, on both transports alike.
    expect(delta).toHaveLength(2);
    expect(delta[0].op).toBe("99");
    expect(delta[0].path).toBe("/x");
    expect(delta[1].op).toBe("replace");
    expect(delta[1].path).toBe("/y");
  });

  it("ignores unknown group fields, per protobuf rules", () => {
    const valid = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    // Field 90 as an empty legacy group: SGROUP then EGROUP.
    const group = new Uint8Array([0xd3, 0x05, 0xd4, 0x05]);
    const extended = new Uint8Array([...valid, ...group]);
    expect((decode(extended) as { stepName?: string }).stepName).toBe("plan");
  });

  it("does not count a known tag inside an unknown group as a duplicate", () => {
    const valid = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    // Field 90 group wrapping field 16 varint 0 and a nested empty group —
    // all unknown-field content a protobuf decoder skips wholesale.
    const group = new Uint8Array([
      0xd3,
      0x05, // SGROUP 90
      0x80,
      0x01,
      0x00, // field 16, varint 0 — inside the group
      0xdb,
      0x05,
      0xdc,
      0x05, // nested SGROUP/EGROUP 91
      0xd4,
      0x05, // EGROUP 90
    ]);
    const extended = new Uint8Array([...valid, ...group]);
    expect((decode(extended) as { stepName?: string }).stepName).toBe("plan");
  });

  it("rejects a repeated envelope tag hidden by an overlong varint", () => {
    const valid = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    // Field 16 (step_finished) again with the SAME valid payload, its tag
    // varint encoded overlong: the real reader masks the fifth byte to four
    // bits and still sees field 16, so only canonical-equivalent duplicate
    // detection catches it — a weaker duplicate would decode fine.
    const payload = valid.slice(2); // length byte + message body
    const overlong = new Uint8Array([0x82, 0x81, 0x80, 0x80, 0x10, ...payload]);
    const extended = new Uint8Array([...valid, ...overlong]);
    expect(() => decode(extended)).toThrow();
  });

  it("rejects a zero field tag", () => {
    const valid = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    const second = encode({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
    } as never);
    // Canonical decoders reject field zero; ts-proto silently stops reading
    // and would surface only the first event.
    const extended = new Uint8Array([...valid, 0x00, 0x00, ...second]);
    expect(() => decode(extended)).toThrow();
  });

  it("rejects a repeated envelope tag", () => {
    const first = encode({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
    } as never);
    const second = encode({ type: EventType.STEP_FINISHED } as never);
    const concatenated = new Uint8Array([...first, ...second]);
    expect(() => decode(concatenated)).toThrow();
  });

  it("carries a subagent success outcome's foreign payload through", () => {
    const decoded = decode(
      wrap({
        subagentFinished: {
          baseEvent: { type: protoEvents.EventType.SUBAGENT_FINISHED },
          subagentRunId: "s1",
          outcome: "success",
          interruptIds: ["i1"],
        },
      }),
    ) as unknown as { outcome?: { type?: string; interruptIds?: unknown[] } };

    expect(decoded.outcome?.type).toBe("success");
    expect(decoded.outcome?.interruptIds).toEqual(["i1"]);
  });
});

describe("the wire code drift gate", () => {
  it("src/generated matches what protoc emits from the committed .proto files", () => {
    // The .proto files are generated by the spec generator (its own diff gate
    // covers them); this closes the second stage — a .proto change without a
    // matching protoc run, or a hand edit to the wire code, fails here.
    const packageDir = join(HERE, "..");
    const out = mkdtempSync(join(tmpdir(), "ag-ui-proto-gate-"));
    execFileSync(process.execPath, [join(packageDir, "scripts", "generate.mjs")], {
      cwd: packageDir,
      env: { ...process.env, PROTO_GENERATED_DIR: out },
      stdio: "pipe",
    });
    const walk = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`],
      );
    // The absolute override must be honoured as given: a rebased path would
    // mint a junk directory inside the package (and an invalid drive-mixed
    // path on Windows).
    expect(existsSync(join(packageDir, out.replace(/^[/\\]/, "")))).toBe(false);
    const committedDir = join(packageDir, "src", "generated");
    const fresh = walk(out).sort();
    expect(walk(committedDir).sort()).toEqual(fresh);
    for (const file of fresh) {
      expect(
        readFileSync(join(committedDir, file), "utf8"),
        `${file} is stale — run: pnpm --filter @ag-ui/proto generate`,
      ).toBe(readFileSync(join(out, file), "utf8"));
    }
  }, 30000);
});
