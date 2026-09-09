import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { decode, encode } from "../proto";

describe("metadata on the unvalidated fallback encode path", () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("still warns for another malformed field after omitting null metadata", () => {
    // Omitting null metadata must not suppress validation of the invalid role.
    const malformed: BaseEvent = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "not-a-valid-role",
    };
    Reflect.set(malformed, "metadata", null);

    const bytes = encode(malformed);
    expect(bytes.length).toBeGreaterThan(0);
    // It took the fallback path rather than validating cleanly.
    expect(warn).toHaveBeenCalled();
  });

  it("omits optional null metadata before validation without a fallback warning", () => {
    const event: BaseEvent = {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
    };
    Reflect.set(event, "metadata", null);

    expect(decode(encode(event))).toEqual({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("metadata inside snapshot messages on the fallback path", () => {
  it("encodes a malformed MESSAGES_SNAPSHOT whose message carries null metadata", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const malformed = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        // An unrecognised role makes the whole event fail validation, so encode
        // falls back to the raw messages — nulls and all.
        { id: "m1", role: "legacy-role", content: "a", metadata: null },
        { id: "m2", role: "assistant", content: "b", metadata: null },
      ],
    } as any;

    let bytes: Uint8Array | undefined;
    expect(() => {
      bytes = encode(malformed);
    }).not.toThrow();
    expect(bytes!.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});

describe("non-object metadata on the fallback path", () => {
  // Struct.wrap would turn an array into {"0":…}, a string into per-character
  // keys, and a number into {} — silently corrupting the value. Dropping it is
  // the honest outcome for a compatibility shim whose contract is to warn and
  // encode best-effort rather than throw.
  it.each([
    ["array", [1, 2, 3]],
    ["string", "not-an-object"],
    ["number", 42],
    ["boolean", true],
  ])("drops %s metadata instead of corrupting it", (_label, value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const malformed = {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
      metadata: value,
    } as any;

    let bytes: Uint8Array | undefined;
    expect(() => {
      bytes = encode(malformed);
    }).not.toThrow();

    const decoded = decode(bytes!) as any;
    expect(decoded.metadata).toBeUndefined();

    warn.mockRestore();
  });

  it("drops non-object metadata on a snapshot message too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const malformed = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "m1", role: "legacy-role", content: "a", metadata: [1, 2] }],
    } as any;

    expect(() => encode(malformed)).not.toThrow();

    warn.mockRestore();
  });
});
