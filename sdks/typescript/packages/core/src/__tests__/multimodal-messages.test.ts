import {
  UserMessageSchema,
  ImageInputContentSchema,
  AudioInputContentSchema,
  VideoInputContentSchema,
  DocumentInputContentSchema,
  ImageInputPartSchema,
  InputContentDataSourceSchema,
  InputContentUrlSourceSchema,
  BinaryInputContentSchema,
} from "../schemas";

const MODALITIES = ["image", "audio", "video", "document"] as const;

const MIME_BY_MODALITY: Record<(typeof MODALITIES)[number], string> = {
  image: "image/png",
  audio: "audio/wav",
  video: "video/mp4",
  document: "application/pdf",
};

const SCHEMA_BY_MODALITY = {
  image: ImageInputContentSchema,
  audio: AudioInputContentSchema,
  video: VideoInputContentSchema,
  document: DocumentInputContentSchema,
} as const;

describe("Multimodal messages", () => {
  it("parses user message with content array", () => {
    const result = UserMessageSchema.parse({
      id: "user_multimodal",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Check this out" },
        {
          type: "image" as const,
          source: {
            type: "url" as const,
            value: "https://example.com/image.png",
            mimeType: "image/png",
          },
        },
      ],
    });

    expect(Array.isArray(result.content)).toBe(true);
    if (Array.isArray(result.content)) {
      expect(result.content[0].type).toBe("text");
      if (result.content[0].type === "text") {
        expect(result.content[0].text).toBe("Check this out");
      }
      expect(result.content[1].type).toBe("image");
      if (result.content[1].type === "image") {
        expect(result.content[1].source.type).toBe("url");
        expect(result.content[1].source.value).toBe("https://example.com/image.png");
      }
    }
  });

  it("parses image part with inline data source", () => {
    const result = ImageInputPartSchema.parse({
      type: "image",
      source: {
        type: "data",
        value: "base64-value",
        mimeType: "image/png",
      },
      metadata: {
        detail: "high",
      },
    });

    expect(result.source.type).toBe("data");
    if (result.source.type === "data") {
      expect(result.source.mimeType).toBe("image/png");
    }
  });

  it("parses url source", () => {
    const result = InputContentUrlSourceSchema.parse({
      type: "url",
      value: "https://example.com/file.pdf",
    });

    expect(result.value).toBe("https://example.com/file.pdf");
  });

  it("parses data source", () => {
    const result = InputContentDataSourceSchema.parse({
      type: "data",
      value: "Zm9v",
      mimeType: "application/pdf",
    });

    expect(result.mimeType).toBe("application/pdf");
  });

  it("rejects binary content without payload source", () => {
    const result = UserMessageSchema.safeParse({
      id: "user_invalid",
      role: "user" as const,
      content: [{ type: "binary" as const, mimeType: "image/png" }],
    });

    expect(result.success).toBe(false);
  });

  it("parses binary input with embedded data", () => {
    const binary = BinaryInputContentSchema.parse({
      type: "binary" as const,
      mimeType: "image/png",
      data: "base64",
    });

    expect(binary.data).toBe("base64");
  });

  it("requires binary payload source", () => {
    expect(() =>
      BinaryInputContentSchema.parse({ type: "binary" as const, mimeType: "image/png" }),
    ).toThrow(/id, url, or data/);
  });

  describe.each(MODALITIES)("%s modality combinations", (modality) => {
    it.each([true, false])("parses url source (metadata: %s)", (withMetadata) => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "url",
          value: `https://example.com/${modality}`,
          mimeType: MIME_BY_MODALITY[modality],
        },
        ...(withMetadata ? { metadata: { providerHint: "high" } } : {}),
      });

      expect(result.type).toBe(modality);
      expect(result.source.type).toBe("url");
      expect(result.source.value).toBe(`https://example.com/${modality}`);
      if (withMetadata) {
        expect(result.metadata).toEqual({ providerHint: "high" });
      } else {
        expect(result.metadata).toBeUndefined();
      }
    });

    it.each([true, false])("parses data source (metadata: %s)", (withMetadata) => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "data",
          value: "Zm9v",
          mimeType: MIME_BY_MODALITY[modality],
        },
        ...(withMetadata ? { metadata: { providerHint: "high" } } : {}),
      });

      expect(result.type).toBe(modality);
      expect(result.source.type).toBe("data");
      if (result.source.type === "data") {
        expect(result.source.mimeType).toBe(MIME_BY_MODALITY[modality]);
      }
      if (withMetadata) {
        expect(result.metadata).toEqual({ providerHint: "high" });
      } else {
        expect(result.metadata).toBeUndefined();
      }
    });

    it("accepts url source without mimeType", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "url",
          value: `https://example.com/${modality}/raw`,
        },
      });

      expect(result.source.type).toBe("url");
      if (result.source.type === "url") {
        expect(result.source.mimeType).toBeUndefined();
      }
    });

    it("rejects data source without mimeType", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
        source: {
          type: "data",
          value: "Zm9v",
        },
      });

      expect(result.success).toBe(false);
    });

    it("rejects missing source", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
      });

      expect(result.success).toBe(false);
    });

    it("rejects invalid source discriminator", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
        source: {
          type: "file",
          value: "abc",
        },
      });

      expect(result.success).toBe(false);
    });
  });

  it("parses a user message containing all modalities", () => {
    const result = UserMessageSchema.parse({
      id: "user_all_modalities",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Process all inputs" },
        {
          type: "image" as const,
          source: { type: "url" as const, value: "https://example.com/image.png" },
        },
        {
          type: "audio" as const,
          source: { type: "data" as const, value: "Zm9v", mimeType: "audio/wav" },
        },
        {
          type: "video" as const,
          source: { type: "url" as const, value: "https://example.com/video.mp4" },
        },
        {
          type: "document" as const,
          source: { type: "data" as const, value: "YmFy", mimeType: "application/pdf" },
        },
      ],
    });

    expect(Array.isArray(result.content)).toBe(true);
    if (Array.isArray(result.content)) {
      expect(result.content.map((item) => item.type)).toEqual([
        "text",
        "image",
        "audio",
        "video",
        "document",
      ]);
    }
  });
});
