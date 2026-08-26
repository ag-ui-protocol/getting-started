import { describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { decode, encode } from "../proto";

describe("metadata on the unvalidated fallback encode path", () => {
  it("encodes an event that fails validation and carries a null metadata object", () => {
    // encode() falls back to the raw, unvalidated event when EventSchemas.parse
    // throws, to stay compatible with producers emitting slightly-off events.
    // A Pydantic producer dumping without exclude_none emits "metadata": null,
    // which every SDK reads as absent — so the fallback must not crash on it.
    // Before the fix this reached Struct.wrap(null) and threw a TypeError.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const malformed = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "not-a-valid-role",
      metadata: null,
    } as any;

    let bytes: Uint8Array | undefined;
    expect(() => {
      bytes = encode(malformed);
    }).not.toThrow();
    expect(bytes!.length).toBeGreaterThan(0);
    // It took the fallback path rather than validating cleanly.
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("treats an event whose metadata is explicitly null as malformed", () => {
    // A whole-object null is a contract violation (metadata is absent or an
    // object, never null — see OptionalMetadataSchema), so validation rejects
    // it and encoding succeeds only through the warn-and-encode fallback.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let bytes: Uint8Array | undefined;
    expect(() => {
      bytes = encode({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        metadata: null,
      } as any);
    }).not.toThrow();
    expect(bytes!.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
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
