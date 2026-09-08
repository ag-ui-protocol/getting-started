import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import type { InputContent } from "@ag-ui/core";

import {
  convertAguiContentToStrands,
  convertAguiContentToStrandsDetailed,
  createUrlFetchCache,
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

/** Discards diagnostics, for cases that assert on blocks rather than logs. */
const quietLog = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/** The fetch policy resolves the host first, so it has to answer publicly. */
function mockPublicDns() {
  return vi
    .spyOn(dns.promises, "lookup")
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
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
    const dnsSpy = mockPublicDns();
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
      { type: "text", text: "read this" },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("pdfdata"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as { type: string }).type).toBe("documentBlock");
    expect((blocks[1] as unknown as { format: string }).format).toBe("pdf");
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
    // A bare spy calls through to the real socket, so a regression here would
    // be caught (if at all) by the network refusing the fixture host rather
    // than by the assertion below. The stub makes the fetch observable.
    const dnsSpy = mockPublicDns();
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(
        new Response(new Uint8Array([9, 9, 9]), { status: 200 }),
      );
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
    expect(
      (blocks[0] as unknown as { source: { bytes: Uint8Array } }).source.bytes,
    ).toEqual(new Uint8Array(Buffer.from("PNG")));
    expect(fetchMock).not.toHaveBeenCalled();
    dnsSpy.mockRestore();
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

  it("bounds and strips an unknown content type before reporting it", async () => {
    // Newline and ESC are the obvious ones, but a log or terminal sink is
    // driven just as well by DEL, the C1 8-bit CSI, and the file separators
    // between them, so the whole control range has to go.
    const controls = "\n\u001b\u001c\u007f\u009b";
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [
        { type: `evil${controls}type${"x".repeat(200)}` },
      ] as unknown as InputContent[],
      quietLog,
    );
    const reported = dropped[0]!.type;
    // The value is whatever the client sent, and it goes out on the wire
    // beside a field documented as safe to put there.
    for (const ch of controls) {
      expect(reported).not.toContain(ch);
    }
    expect(reported.length).toBeLessThanOrEqual(45);
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

  it("reads the response content type when the source declares none", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi.spyOn(urlFetchTransport, "request").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    try {
      const blocks = await convertAguiContentToStrands([
        {
          type: "image",
          source: { type: "url", value: "https://example.test/untyped" },
        },
      ] as InputContent[]);
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as unknown as { format: string }).format).toBe("png");
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("drops a url attachment when neither the source nor the response types it", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    const log = makeLog();
    try {
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "image",
            source: { type: "url", value: "https://example.test/untyped" },
          },
        ] as InputContent[],
        log,
      );
      expect(blocks).toEqual([]);
      expect(messages(log)).toContain("No MIME type provided");
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("prefers the declared type over the response content type", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi.spyOn(urlFetchTransport, "request").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/gif" },
      }),
    );
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
      expect((blocks[0] as unknown as { format: string }).format).toBe("png");
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("inserts a text block when the message carries only documents", async () => {
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
    // The provider rejects a request whose message has documents and no text.
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { type: string }).type).toBe("textBlock");
    expect((blocks[0] as unknown as { text: string }).text).toBe(" ");
    expect((blocks[1] as { type: string }).type).toBe("documentBlock");
  });

  it("pads a document message whose only text item is empty", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "" },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("pdfdata"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[]);
    // toContain(" ") would pass on ["", " "], which is the shape that still
    // fails at the provider. The whole list is the assertion.
    const texts = blocks
      .filter((b) => (b as { type: string }).type === "textBlock")
      .map((b) => (b as unknown as { text: string }).text);
    expect(texts).toEqual([" "]);
  });

  it.each([
    ["no source at all", { type: "image" }],
    ["a null source", { type: "image", source: null }],
    [
      "a non-string mimeType",
      {
        type: "image",
        source: { type: "data", value: "UE5H", mimeType: 42 },
      },
    ],
  ])("drops an image with %s instead of throwing", async (_label, item) => {
    const blocks = await convertAguiContentToStrands(
      [item, { type: "text", text: "survivor" }] as unknown as InputContent[],
      quietLog,
    );
    // The surrounding content must survive a malformed neighbour.
    expect(blocks.map((b) => (b as unknown as { text?: string }).text)).toEqual(
      ["survivor"],
    );
  });

  it("does not believe a served type from the wrong family", async () => {
    const dnsSpy = mockPublicDns();
    const log = makeLog();
    // `text/png` is the case that discriminates: the subtype is a valid image
    // format, so the format check alone would accept it, and only the
    // top-level check notices that the server relabelled the payload across
    // families. A response whose subtype is also wrong is already refused by
    // the format check, so it would not test this at all.
    vi.spyOn(urlFetchTransport, "request").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "text/png" },
        }),
    );
    try {
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "image",
            source: { type: "url", value: "https://example.test/missing" },
          },
        ] as InputContent[],
        log,
      );
      expect(blocks).toEqual([]);
      // Named specifically: without this, a refusal for any other reason
      // satisfies the assertion above.
      expect(messages(log)).toContain("text/png");
      expect(messages(log)).toContain("not one of");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  it("still believes a served type from the right family", async () => {
    const dnsSpy = mockPublicDns();
    vi.spyOn(urlFetchTransport, "request").mockImplementation(
      async () =>
        new Response("id,name\n1,a", {
          status: 200,
          headers: { "content-type": "text/csv" },
        }),
    );
    try {
      const blocks = await convertAguiContentToStrands(
        [
          { type: "text", text: "read" },
          {
            type: "document",
            source: { type: "url", value: "https://example.test/data" },
          },
        ] as InputContent[],
        quietLog,
      );
      expect((blocks[1] as unknown as { format: string }).format).toBe("csv");
    } finally {
      dnsSpy.mockRestore();
    }
  });

  it("drops a null element instead of crashing the conversion", async () => {
    const log = makeLog();
    const { blocks, dropped } = await convertAguiContentToStrandsDetailed(
      [
        null,
        undefined,
        "not an object",
        { type: "text", text: "survivor" },
      ] as unknown as InputContent[],
      log,
    );
    expect(blocks.map((b) => (b as unknown as { text?: string }).text)).toEqual(
      ["survivor"],
    );
    expect(messages(log)).toContain("not an object");
    // Same rule as a malformed text item: `dropped` is the media report, so a
    // bare null in the array is not announced to the client as lost media.
    expect(dropped).toEqual([]);
  });

  it.each([
    [
      "an unsupported type",
      { type: "data", value: "eA==", mimeType: "image/bmp" },
      "image/bmp",
    ],
    [
      "bad base64",
      { type: "data", value: "!!!not base64!!!", mimeType: "image/png" },
      "base64",
    ],
    [
      "a non-string value",
      { type: "data", value: 42, mimeType: "image/png" },
      "no usable value",
    ],
  ])(
    "logs one line per dropped item, not two: %s",
    async (_l, source, needle) => {
      const log = makeLog();
      await convertAguiContentToStrands(
        [{ type: "image", source }] as unknown as InputContent[],
        log,
      );
      // The reason and the item's position belong on the same line; two lines
      // for one drop is what makes a multi-attachment failure hard to read. The
      // first version of this test used the one branch where that already held.
      expect(log.warn.mock.calls).toHaveLength(1);
      const only = String(log.warn.mock.calls[0]![0]);
      expect(only).toContain(needle);
      expect(only).toContain("item 0");
    },
  );

  it("names the message a dropped item came from", async () => {
    const log = makeLog();
    await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: "data", value: b64("x"), mimeType: "image/bmp" },
        },
      ] as InputContent[],
      log,
      { messageId: "msg-42" },
    );
    expect(messages(log)).toContain("msg-42");
  });

  it.each([
    ["a url source", "url"],
    ["a data source", "data"],
  ])("drops %s whose value is not a string", async (_label, kind) => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: kind, value: 42, mimeType: "image/png" },
        },
        { type: "text", text: "survivor" },
      ] as unknown as InputContent[],
      log,
    );
    // Both are refused at the source before either branch runs. Left to the
    // branches, the data case would be coerced by atob and shipped as content,
    // and the url case would throw from inside the fetch's own error handler,
    // where the URL is hashed for logging, escaping the catch written to
    // contain it.
    expect(blocks.map((b) => (b as unknown as { text?: string }).text)).toEqual(
      ["survivor"],
    );
    expect(messages(log)).toContain("no usable value");
  });

  it("falls back to the url on the deprecated binary path when data is absent", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi.spyOn(urlFetchTransport, "request").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
        }),
    );
    try {
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "binary",
            mimeType: "image/png",
            url: "https://example.test/legacy.png",
          },
        ] as unknown as InputContent[],
        quietLog,
      );
      // Every other test on this path asserts the negative, so the branch that
      // actually succeeds was never run.
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as { type: string }).type).toBe("imageBlock");
      expect(
        (blocks[0] as unknown as { source: { bytes: Uint8Array } }).source
          .bytes,
      ).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      dnsSpy.mockRestore();
    }
  });

  it("reports a malformed source as malformed, not as unresolvable", async () => {
    const log = makeLog();
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [{ type: "image" }] as unknown as InputContent[],
      log,
    );
    // A caller can fix a malformed item and cannot fix a host that will not
    // answer, so the two must not read the same.
    expect(dropped).toEqual([
      { type: "image", reason: "content item is malformed" },
    ]);
    // And it has to be visible: this drop had no log line at all for a while.
    expect(messages(log)).toContain("malformed");
  });

  it("reports a binary item with non-string data as malformed", async () => {
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [
        { type: "binary", mimeType: "image/png", data: 42 },
      ] as unknown as InputContent[],
      quietLog,
    );
    // Not "empty": a caller can fix a malformed payload, and the two read
    // differently to whoever receives the report.
    expect(dropped).toEqual([
      { type: "binary", reason: "content item is malformed" },
    ]);
  });

  it("reports a binary item with a non-string type as untyped", async () => {
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [
        { type: "binary", mimeType: 42, data: "UE5H" },
      ] as unknown as InputContent[],
      quietLog,
    );
    // The log says no usable type, so the wire reason must agree.
    expect(dropped).toEqual([
      { type: "binary", reason: "no media type declared or returned" },
    ]);
  });

  it("keeps a malformed text item out of the media drop report", async () => {
    const { blocks, dropped } = await convertAguiContentToStrandsDetailed(
      [
        { type: "text" },
        {
          type: "image",
          source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
        },
      ] as unknown as InputContent[],
      quietLog,
    );
    expect(blocks).toHaveLength(1);
    // The report reaches a client beside a count of media delivered; a text
    // item in it would read as a lost attachment.
    expect(dropped).toEqual([]);
  });

  it("drops a binary item with a non-string type instead of throwing", async () => {
    const blocks = await convertAguiContentToStrands(
      [
        { type: "binary", mimeType: 42, data: "UE5H" },
        { type: "text", text: "survivor" },
      ] as unknown as InputContent[],
      quietLog,
    );
    expect(blocks.map((b) => (b as unknown as { text?: string }).text)).toEqual(
      ["survivor"],
    );
  });

  it("reports a binary item with no type as untyped", async () => {
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [{ type: "binary", data: "UE5H" }] as unknown as InputContent[],
      quietLog,
    );
    expect(dropped).toEqual([
      { type: "binary", reason: "no media type declared or returned" },
    ]);
  });

  it("drops a malformed text item instead of failing the conversion", async () => {
    const log = makeLog();
    // A throw here would take the surrounding attachments down with it, which
    // is the one outcome the whole drop-and-report design exists to avoid.
    const blocks = await convertAguiContentToStrands(
      [
        { type: "text" },
        { type: "text", text: null },
        {
          type: "image",
          source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
        },
      ] as unknown as InputContent[],
      log,
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("imageBlock");
    expect(messages(log)).toContain("no usable text field");
  });

  it("does not throw when a malformed text item sits beside a document", async () => {
    const blocks = await convertAguiContentToStrands(
      [
        { type: "text" },
        {
          type: "document",
          source: {
            type: "data",
            value: b64("pdfdata"),
            mimeType: "application/pdf",
          },
        },
      ] as unknown as InputContent[],
      quietLog,
    );
    // The document survives and still gets its padding.
    expect(blocks.map((b) => (b as { type: string }).type)).toEqual([
      "textBlock",
      "documentBlock",
    ]);
  });

  it("drops an empty text item rather than sending an empty block", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "" },
      { type: "text", text: "real" },
    ] as InputContent[]);
    expect(blocks.map((b) => (b as unknown as { text: string }).text)).toEqual([
      "real",
    ]);
  });

  it("does not pad a document message that already carries text", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "summarise this" },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("pdfdata"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as unknown as { text: string }).text).toBe(
      "summarise this",
    );
  });

  it("does not pad an image-only message", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "image",
        source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("imageBlock");
  });

  it("gives two documents in one message distinct names", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "compare" },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("one"),
          mimeType: "application/pdf",
        },
      },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("two"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[]);
    const names = blocks
      .filter((b) => (b as { type: string }).type === "documentBlock")
      .map((b) => (b as unknown as { name: string }).name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("gives byte-identical documents in one message distinct names", async () => {
    const same = {
      type: "document",
      source: { type: "data", value: b64("same"), mimeType: "application/pdf" },
    };
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "compare" },
      same,
      same,
    ] as InputContent[]);
    const names = blocks
      .filter((b) => (b as { type: string }).type === "documentBlock")
      .map((b) => (b as unknown as { name: string }).name);
    expect(new Set(names).size).toBe(2);
  });

  it("derives the name from the content, not just the position", async () => {
    // A bare index satisfies the replay-stability case below just as well, so
    // this is what separates the content digest from a counter.
    const nameOf = (blocks: unknown[]) => (blocks[1] as { name: string }).name;
    const docOf = (value: string) =>
      [
        { type: "text", text: "read" },
        {
          type: "document",
          source: {
            type: "data",
            value: b64(value),
            mimeType: "application/pdf",
          },
        },
      ] as InputContent[];
    const one = await convertAguiContentToStrands(docOf("one"), quietLog, {
      messageId: "msg-1",
    });
    const two = await convertAguiContentToStrands(docOf("two"), quietLog, {
      messageId: "msg-1",
    });
    expect(nameOf(one)).not.toBe(nameOf(two));
  });

  it("gives identical documents in two messages distinct names", async () => {
    // Each message is converted by its own call, so a per-call counter would
    // give both of these the same name and the provider would reject the one
    // request they share.
    const content = [
      { type: "text", text: "read" },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("same"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[];
    const first = await convertAguiContentToStrands(content, quietLog, {
      messageId: "msg-1",
    });
    const second = await convertAguiContentToStrands(content, quietLog, {
      messageId: "msg-2",
    });
    expect((first[1] as unknown as { name: string }).name).not.toBe(
      (second[1] as unknown as { name: string }).name,
    );
  });

  it("names the same document identically across replays", async () => {
    const content = [
      { type: "text", text: "read" },
      {
        type: "document",
        source: {
          type: "data",
          value: b64("stable"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[];
    const first = await convertAguiContentToStrands(content, quietLog, {
      messageId: "msg-1",
    });
    const second = await convertAguiContentToStrands(content, quietLog, {
      messageId: "msg-1",
    });
    const nameOf = (blocks: unknown[]) => (blocks[1] as { name: string }).name;
    expect(nameOf(first)).toBe(nameOf(second));
  });

  it.each([
    ["text/plain", "txt"],
    ["text/markdown", "md"],
    ["text/x-markdown", "md"],
    ["application/msword", "doc"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ],
    ["application/vnd.ms-excel", "xls"],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
    ],
    ["application/pdf", "pdf"],
    ["text/csv", "csv"],
    ["text/html", "html"],
  ])("reaches the %s document format", async (mimeType, format) => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        { type: "text", text: "read" },
        {
          type: "document",
          source: { type: "data", value: b64("body"), mimeType },
        },
      ] as InputContent[],
      log,
    );
    expect((blocks[1] as unknown as { format: string }).format).toBe(format);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["video/mp4", "mp4"],
    ["video/webm", "webm"],
    ["video/mpeg", "mpeg"],
    ["video/quicktime", "mov"],
    ["video/x-matroska", "mkv"],
    // "3gp", not Bedrock's "three_gp": the SDK's own Bedrock provider does
    // that translation on the way out, so emitting three_gp here would skip
    // it and hand every other provider a format it does not know.
    ["video/3gpp", "3gp"],
    ["video/x-flv", "flv"],
    ["video/x-ms-wmv", "wmv"],
  ])("reaches the %s video format", async (mimeType, format) => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "video",
          source: { type: "data", value: b64("movie"), mimeType },
        },
      ] as InputContent[],
      log,
    );
    expect((blocks[0] as unknown as { format: string }).format).toBe(format);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["image/jpeg", "jpeg"],
    ["image/jpg", "jpeg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ])("reaches the %s image format", async (mimeType, format) => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: "data", value: b64("PNG"), mimeType },
        },
      ] as InputContent[],
      log,
    );
    expect((blocks[0] as unknown as { format: string }).format).toBe(format);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["constructor", "__proto__"])(
    "treats the inherited key %s as an unknown format",
    async (subtype) => {
      const log = makeLog();
      // These two are the discriminators: they are the Object.prototype keys
      // that survive the lowercasing in `mimeSubtype`, so they are the only
      // subtypes that would reach through a plain-object alias map. The other
      // prototype keys are camelCased and never match. The map is already
      // prototype-free, so this pins that rather than describing a live
      // hazard.
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "image",
            source: {
              type: "data",
              value: b64("x"),
              mimeType: `image/${subtype}`,
            },
          },
        ] as InputContent[],
        log,
      );
      expect(blocks).toEqual([]);
      // A prototype lookup puts a Function or an object where the format
      // string goes, and this line would quote that instead of the subtype.
      expect(messages(log)).toContain(`parsed format '${subtype}'`);
    },
  );

  it.each([
    ["text/html, application/pdf", "a comma-merged pair"],
    // Under an "at least two parts" reading, destructuring takes text/pdf and
    // this is accepted as a document, so it is the case that discriminates.
    ["text/pdf/anything", "two slashes"],
    ["noslash", "no slash"],
    ["/pdf", "an empty family"],
    ["application/", "an empty subtype"],
  ])("refuses %s (%s)", async (mimeType) => {
    const log = makeLog();
    // Taking the family from the front and the subtype from the back
    // independently would let a value carrying two types satisfy the family
    // check with one and supply its format from the other.
    const blocks = await convertAguiContentToStrands(
      [
        { type: "text", text: "read" },
        {
          type: "document",
          source: { type: "data", value: b64("body"), mimeType },
        },
      ] as InputContent[],
      log,
    );
    expect(
      blocks.filter((b) => (b as { type: string }).type === "documentBlock"),
    ).toEqual([]);
  });

  it.each(["application/json", "application/xml", "text/xml"])(
    "refuses %s, which the SDK allows but Bedrock does not",
    async (mimeType) => {
      const log = makeLog();
      // The SDK's DocumentFormat union carries json and xml, but document
      // formats reach Bedrock untranslated and its enum has neither, so
      // accepting them would turn one unsupported attachment into a rejected
      // request.
      const blocks = await convertAguiContentToStrands(
        [
          { type: "text", text: "read" },
          {
            type: "document",
            source: { type: "data", value: b64("body"), mimeType },
          },
        ] as InputContent[],
        log,
      );
      expect(
        blocks.filter((b) => (b as { type: string }).type === "documentBlock"),
      ).toEqual([]);
      expect(messages(log)).toContain(mimeType);
    },
  );

  it("strips MIME parameters before matching the format", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        { type: "text", text: "read" },
        {
          type: "document",
          source: {
            type: "data",
            value: b64("hello"),
            mimeType: "text/plain; charset=utf-8",
          },
        },
      ] as InputContent[],
      log,
    );
    expect((blocks[1] as unknown as { format: string }).format).toBe("txt");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("still refuses a type that is unsupported once parameters are stripped", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: {
            type: "data",
            value: b64("x"),
            mimeType: "image/bmp; charset=utf-8",
          },
        },
      ] as InputContent[],
      log,
    );
    expect(blocks).toEqual([]);
    expect(messages(log)).toContain("image/bmp");
  });

  it("drops an inline attachment whose body is empty", async () => {
    const log = makeLog();
    const blocks = await convertAguiContentToStrands(
      [
        {
          type: "image",
          source: { type: "data", value: "", mimeType: "image/png" },
        },
      ] as InputContent[],
      log,
    );
    expect(blocks).toEqual([]);
    expect(messages(log)).toContain("empty");
  });

  it("drops a url attachment whose response has no body", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const log = makeLog();
    try {
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.test/empty.png",
              mimeType: "image/png",
            },
          },
        ] as InputContent[],
        log,
      );
      expect(blocks).toEqual([]);
      expect(messages(log)).toContain("empty");
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("does not fetch a url attachment whose declared type is unsupported", async () => {
    const dnsSpy = mockPublicDns();
    // Stubbed rather than a bare spy: a bare spy would call through, and a
    // regressed guard would then fail on a socket timeout instead of on the
    // assertion written for it.
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    try {
      const blocks = await convertAguiContentToStrands(
        [
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.test/x.bmp",
              mimeType: "image/bmp",
            },
          },
        ] as InputContent[],
        quietLog,
      );
      expect(blocks).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("fetches a url once per request when a shared cache is passed", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi.spyOn(urlFetchTransport, "request").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const cache = createUrlFetchCache();
    const content = [
      {
        type: "image",
        source: {
          type: "url",
          value: "https://example.test/shared.png",
          mimeType: "image/png",
        },
      },
    ] as InputContent[];
    try {
      const first = await convertAguiContentToStrands(content, quietLog, {
        fetchCache: cache,
      });
      const second = await convertAguiContentToStrands(content, quietLog, {
        fetchCache: cache,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        (first[0] as unknown as { source: { bytes: Uint8Array } }).source.bytes,
      ).toEqual(new Uint8Array([1, 2, 3]));
      expect(
        (second[0] as unknown as { source: { bytes: Uint8Array } }).source
          .bytes,
      ).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("does not retry a refused url within one request", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const cache = createUrlFetchCache();
    const content = [
      {
        type: "image",
        source: {
          type: "url",
          value: "https://example.test/gone.png",
          mimeType: "image/png",
        },
      },
    ] as InputContent[];
    try {
      await convertAguiContentToStrands(content, quietLog, {
        fetchCache: cache,
      });
      await convertAguiContentToStrands(content, quietLog, {
        fetchCache: cache,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });

  it("fetches every request separately when no cache is shared", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi.spyOn(urlFetchTransport, "request").mockImplementation(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const content = [
      {
        type: "image",
        source: {
          type: "url",
          value: "https://example.test/uncached.png",
          mimeType: "image/png",
        },
      },
    ] as InputContent[];
    try {
      await convertAguiContentToStrands(content);
      await convertAguiContentToStrands(content);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      dnsSpy.mockRestore();
    }
  });
});

describe("media drop reasons", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("separates an untyped response from an unsupported one", async () => {
    const dnsSpy = mockPublicDns();
    const cases: Array<[string | undefined, string]> = [
      [undefined, "no media type declared or returned"],
      // image/* so the top-level check passes and the format check is what
      // actually decides, which is the distinction under test.
      ["image/bmp", "unsupported media type"],
    ];
    try {
      for (const [contentType, reason] of cases) {
        // mockImplementation, not mockResolvedValue: a Response body reads
        // once, so a shared instance would make the second iteration behave
        // differently from the first for reasons this test is not about.
        vi.spyOn(urlFetchTransport, "request").mockImplementation(
          async () =>
            new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              ...(contentType
                ? { headers: { "content-type": contentType } }
                : {}),
            }),
        );
        const { dropped } = await convertAguiContentToStrandsDetailed(
          [
            {
              type: "image",
              source: { type: "url", value: "https://example.test/x" },
            },
          ] as InputContent[],
          quietLog,
        );
        // A caller can declare a type to fix the first and cannot fix the
        // second, so the two must not read the same on the wire.
        expect(dropped).toEqual([{ type: "image", reason }]);
      }
    } finally {
      dnsSpy.mockRestore();
    }
  });

  it("does not fetch a binary url when inline data is present but empty", async () => {
    const dnsSpy = mockPublicDns();
    const fetchMock = vi
      .spyOn(urlFetchTransport, "request")
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    try {
      const { blocks, dropped } = await convertAguiContentToStrandsDetailed(
        [
          {
            type: "binary",
            mimeType: "image/png",
            data: "",
            url: "https://example.test/fallback.png",
          },
        ] as unknown as InputContent[],
        quietLog,
      );
      expect(blocks).toEqual([]);
      // Sending an empty `data` is sending nothing, not asking for the URL.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dropped).toEqual([
        { type: "binary", reason: "content was empty" },
      ]);
    } finally {
      dnsSpy.mockRestore();
    }
  });
});

describe("cancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("abandons an in-flight download when the caller goes away", async () => {
    const dnsSpy = mockPublicDns();
    // Parks until the transport's own signal fires, which is the only way this
    // resolves: if the caller's abort never reaches the fetch, the await below
    // never returns and the test times out.
    vi.spyOn(urlFetchTransport, "request").mockImplementation(
      (_t, _a, _p, signal) =>
        new Promise((_resolve, reject) => {
          const s = signal as AbortSignal;
          const stop = () => reject(new Error("aborted"));
          // Already aborted is the ordinary case here: the caller gives up
          // while the fetch is still resolving DNS, so the signal has fired
          // before the transport is reached and no event is coming.
          if (s.aborted) stop();
          else s.addEventListener("abort", stop, { once: true });
        }) as never,
    );
    const controller = new AbortController();
    try {
      const pending = convertAguiContentToStrands(
        [
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.test/slow.png",
              mimeType: "image/png",
            },
          },
        ] as InputContent[],
        quietLog,
        { signal: controller.signal },
      );
      controller.abort();
      expect(await pending).toEqual([]);
    } finally {
      dnsSpy.mockRestore();
    }
  });
});

describe("convertAguiContentToStrandsDetailed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports nothing dropped when every item converts", async () => {
    const { blocks, dropped } = await convertAguiContentToStrandsDetailed(
      [
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
        },
      ] as InputContent[],
      quietLog,
    );
    expect(blocks).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it("distinguishes a partial loss from a message that carried no media", async () => {
    const withoutMedia = await convertAguiContentToStrandsDetailed(
      [{ type: "text", text: "no attachments here" }] as InputContent[],
      quietLog,
    );
    const partiallyLost = await convertAguiContentToStrandsDetailed(
      [
        { type: "text", text: "one of these two survived" },
        {
          type: "image",
          source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
        },
        {
          type: "image",
          source: { type: "data", value: b64("BMP"), mimeType: "image/bmp" },
        },
      ] as InputContent[],
      quietLog,
    );
    expect(withoutMedia.dropped).toEqual([]);
    expect(partiallyLost.blocks).toHaveLength(2);
    expect(partiallyLost.dropped).toEqual([
      { type: "image", reason: "unsupported media type" },
    ]);
  });

  it("reports the reason a document was dropped", async () => {
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [
        {
          type: "document",
          source: {
            type: "data",
            value: "",
            mimeType: "application/pdf",
          },
        },
      ] as InputContent[],
      quietLog,
    );
    expect(dropped).toEqual([
      { type: "document", reason: "content was empty" },
    ]);
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
  it("converts a bare {text} block rather than reporting it as lost media", async () => {
    const { blocks, dropped } = await convertAguiContentToStrandsDetailed(
      [{ text: "serialized" }] as unknown as InputContent[],
      quietLog,
    );
    // flattenContentToText already reads this shape as text, so reporting it
    // to the client as a lost attachment contradicted the sibling path.
    expect((blocks[0] as unknown as { text: string }).text).toBe("serialized");
    expect(dropped).toEqual([]);
  });

  it("reads the SDK's serialized bare {text} blocks", () => {
    // What TextBlock.toJSON() produces and _buildStrandsHistory stores: no
    // type discriminant at all. Missing this made a replayed turn flatten to
    // the empty string.
    expect(
      flattenContentToText([{ text: "serialized" }, { text: "blocks" }]),
    ).toBe("serialized blocks");
  });

  it("does not treat a non-text block's text field as text", () => {
    expect(flattenContentToText([{ type: "jsonBlock", text: "nope" }])).toBe(
      "",
    );
  });

  it("reads a single block that is not in a list", () => {
    expect(flattenContentToText({ type: "text", text: "alone" })).toBe("alone");
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
