import { describe, it, expect } from "vitest";

import { buildAguiToolMessage } from "./utils";

describe("buildAguiToolMessage", () => {
  // ── Shared edge cases (independent of concatenate flag) ──

  it("handles empty content array", () => {
    const msg = buildAguiToolMessage("tu-6", []);

    expect(msg.content).toBe("[]");
  });

  it("handles null content", () => {
    const msg = buildAguiToolMessage("tu-7", null);

    expect(msg.content).toBe("");
  });

  it("handles non-array content by serializing it", () => {
    const msg = buildAguiToolMessage("tu-8", "raw string");

    expect(msg.content).toBe('"raw string"');
  });

  it("generates correct id format", () => {
    const msg = buildAguiToolMessage("tu-10", [
      { type: "text", text: "test" },
    ]);

    expect(msg.id).toBe("tu-10-result");
  });

  // ── Default behavior (concatenate = false): single-block ──

  describe("concatenate disabled (default)", () => {
    it("reads only the first text block", () => {
      const content = [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
        { type: "text", text: "Third" },
      ];

      const msg = buildAguiToolMessage("tu-d1", content);

      // Only block 0 is read; the rest are silently ignored.
      expect(msg.content).toBe("First");
    });

    it("handles a single text block unchanged", () => {
      const content = [{ type: "text", text: "Only block" }];

      const msg = buildAguiToolMessage("tu-d2", content);

      expect(msg.content).toBe("Only block");
    });

    it("passes non-JSON text through without modification", () => {
      const content = [{ type: "text", text: "just plain text, not JSON" }];

      const msg = buildAguiToolMessage("tu-d3", content);

      expect(msg.content).toBe("just plain text, not JSON");
    });

    it("falls back to JSON.stringify when first block is non-text", () => {
      const content = [
        { type: "image", source: { type: "base64", data: "abc" } },
      ];

      const msg = buildAguiToolMessage("tu-d4", content);

      expect(msg.content).toBe(JSON.stringify(content));
    });

    it("re-serializes JSON text (round-trip behavior)", () => {
      const jsonText = '{"key": "value",  "extra_spaces":  true}';
      const content = [{ type: "text", text: jsonText }];

      const msg = buildAguiToolMessage("tu-d5", content);

      expect(msg.content).toBe('{"key":"value","extra_spaces":true}');
    });
  });

  // ── Opt-in behavior (concatenate = true): multi-block ──

  describe("concatenate enabled", () => {
    it("concatenates all text blocks from a multi-block result", () => {
      const content = [
        { type: "text", text: "Line one" },
        { type: "text", text: "Line two" },
        { type: "text", text: "Line three" },
      ];

      const msg = buildAguiToolMessage("tu-c1", content, true);

      expect(msg.content).toBe("Line one\nLine two\nLine three");
      expect(msg.role).toBe("tool");
      expect((msg as { toolCallId?: string }).toolCallId).toBe("tu-c1");
    });

    it("handles a single text block unchanged", () => {
      const content = [{ type: "text", text: "Only block" }];

      const msg = buildAguiToolMessage("tu-c2", content, true);

      expect(msg.content).toBe("Only block");
    });

    it("passes non-JSON text through without modification", () => {
      const content = [{ type: "text", text: "just plain text, not JSON" }];

      const msg = buildAguiToolMessage("tu-c3", content, true);

      expect(msg.content).toBe("just plain text, not JSON");
    });

    it("falls back to JSON.stringify for non-text blocks", () => {
      const content = [
        { type: "image", source: { type: "base64", data: "abc" } },
      ];

      const msg = buildAguiToolMessage("tu-c4", content, true);

      expect(msg.content).toBe(JSON.stringify(content));
    });

    it("preserves all blocks (including non-text) in mixed content via JSON", () => {
      const content = [
        { type: "text", text: "First" },
        { type: "image", source: { type: "base64", data: "abc" } },
        { type: "text", text: "Second" },
      ];

      const msg = buildAguiToolMessage("tu-c5", content, true);

      // Mixed content is serialized losslessly so non-text blocks survive
      expect(msg.content).toBe(JSON.stringify(content));
    });

    it("preserves non-text-first mixed content without dropping the image", () => {
      const content = [
        { type: "image", source: { type: "base64", data: "img-data" } },
        { type: "text", text: "Caption" },
      ];

      const msg = buildAguiToolMessage("tu-c6", content, true);

      const parsed = JSON.parse(msg.content as string);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].type).toBe("image");
      expect(parsed[0].source.data).toBe("img-data");
      expect(parsed[1].type).toBe("text");
      expect(parsed[1].text).toBe("Caption");
    });

    it("re-serializes JSON text (round-trip behavior)", () => {
      const jsonText = '{"key": "value",  "extra_spaces":  true}';
      const content = [{ type: "text", text: jsonText }];

      const msg = buildAguiToolMessage("tu-c7", content, true);

      expect(msg.content).toBe('{"key":"value","extra_spaces":true}');
    });
  });
});
