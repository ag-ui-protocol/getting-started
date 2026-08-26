import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import type { InputContent } from "@ag-ui/core";

import {
  convertAguiContentToStrands,
  flattenContentToText,
  urlFetchTransport,
} from "../utils";

function b64(input: string): string {
  return Buffer.from(input).toString("base64");
}

type LogMethod = (message: string, ...args: unknown[]) => void;

/**
 * A stub logger. Passing one keeps the converter's diagnostics out of the
 * suite's stderr and lets a test assert that a dropped item was reported
 * rather than lost quietly.
 */
function makeLog() {
  return {
    debug: vi.fn<LogMethod>(),
    warn: vi.fn<LogMethod>(),
    error: vi.fn<LogMethod>(),
  };
}

function messages(log: { warn: { mock: { calls: unknown[][] } } }): string {
  return log.warn.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("convertAguiContentToStrands", () => {
  afterEach(() => {
    // vitest is not configured with restoreMocks, so an inline finally in one
    // case is not enough.
    vi.restoreAllMocks();
  });

  it("maps TextInputContent to a TextBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "hello" },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("textBlock");
    expect((blocks[0] as unknown as { text: string }).text).toBe("hello");
  });

  it("maps ImageInputContent with a data source to an ImageBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "image",
        source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("imageBlock");
    expect((blocks[0] as unknown as { format: string }).format).toBe("png");
  });

  it("skips images with an unsupported MIME type and says why", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: "data", value: b64("xxx"), mimeType: "image/bmp" },
        },
      ] as InputContent[],
      log,
    );
    expect(blocks).toHaveLength(0);
    expect(messages(log)).toContain("image/bmp");
  });

  it("fetches url-sourced images", async () => {
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    // The fetch policy resolves the host before connecting, so the fixture
    // host has to answer with a public address.
    const dnsSpy = vi
      .spyOn(dns.promises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    try {
      const blocks = await convertAguiContentToStrands([
        {
          type: "image",
          source: {
            type: "url",
            value: "https://example.test/x.png",
            mimeType: "image/png",
          },
        },
      ] as InputContent[]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(blocks).toHaveLength(1);
      expect(
        (blocks[0] as unknown as { source: { bytes: Uint8Array } }).source
          .bytes,
      ).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      dnsSpy.mockRestore();
      fetchMock.mockRestore();
    }
  });

  it("maps DocumentInputContent to a DocumentBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "document",
        source: {
          type: "data",
          value: b64("pdfdata"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("documentBlock");
  });

  it("maps VideoInputContent to a VideoBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "video",
        source: { type: "data", value: b64("movie"), mimeType: "video/mp4" },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("videoBlock");
  });

  it("skips audio content, keeping the surrounding text", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        { type: "text", text: "before" },
        {
          type: "audio",
          source: { type: "data", value: b64("sound"), mimeType: "audio/wav" },
        },
        { type: "text", text: "after" },
      ] as InputContent[],
      log,
    );
    // Just the two text blocks remain
    expect(blocks).toHaveLength(2);
    // The audio-specific reason, not just the word: the unknown-type fallback
    // would satisfy a looser assertion.
    expect(messages(log)).toContain("Strands has no audio support");
  });

  it("drops items with bad base64 data rather than throwing", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: {
            type: "data",
            value: "!!!not base64!!!",
            mimeType: "image/png",
          },
        },
      ] as InputContent[],
      log,
    );
    expect(blocks).toEqual([]);
    expect(messages(log)).toContain("base64");
  });

  it("maps the deprecated binary content type with inline data", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        { type: "binary", mimeType: "image/png", data: b64("PNG") },
      ] as unknown as InputContent[],
      log,
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("imageBlock");
    expect((blocks[0] as unknown as { format: string }).format).toBe("png");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("prefers inline data over a URL on the deprecated binary path", async () => {
    const fetchMock = vi.spyOn(urlFetchTransport, "request");
    const log = makeLog();

    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "binary",
          mimeType: "image/png",
          data: b64("PNG"),
          url: "https://example.test/should-not-be-fetched.png",
        },
      ] as unknown as InputContent[],
      log,
    );

    expect(blocks).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops deprecated binary content with an unsupported MIME type", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        { type: "binary", mimeType: "image/bmp", data: b64("BMP") },
      ] as unknown as InputContent[],
      log,
    );
    expect(blocks).toEqual([]);
    expect(messages(log)).toContain("image/bmp");
  });

  it("accepts an uppercase MIME type", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: "data", value: b64("PNG"), mimeType: "IMAGE/PNG" },
        },
      ] as InputContent[],
      log,
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as unknown as { format: string }).format).toBe("png");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reports an unknown source type rather than dropping it quietly", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: "carrier-pigeon", value: "x", mimeType: "image/png" },
        },
      ] as unknown as InputContent[],
      log,
    );
    expect(blocks).toEqual([]);
    expect(messages(log)).toContain("carrier-pigeon");
  });

  it("reports an unknown content type rather than dropping it quietly", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [{ type: "hologram" }] as unknown as InputContent[],
      log,
    );
    expect(blocks).toEqual([]);
    expect(messages(log)).toContain("hologram");
  });
});

describe("flattenContentToText", () => {
  it("reads Strands textBlock content, which agent.ts feeds it directly", () => {
    expect(
      flattenContentToText([
        { type: "textBlock", text: "from" },
        { type: "textBlock", text: "strands" },
      ]),
    ).toBe("from strands");
  });
  it("returns a string input as-is", () => {
    expect(flattenContentToText("hi")).toBe("hi");
  });
  it("returns empty string for null / undefined", () => {
    expect(flattenContentToText(null)).toBe("");
    expect(flattenContentToText(undefined)).toBe("");
  });
  it("joins TextInputContent segments with a space", () => {
    expect(
      flattenContentToText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });
  it("ignores non-text blocks", () => {
    expect(
      flattenContentToText([
        { type: "text", text: "a" },
        {
          type: "image",
          source: { type: "data", value: "x", mimeType: "image/png" },
        },
        { type: "text", text: "b" },
      ]),
    ).toBe("a b");
  });
});
