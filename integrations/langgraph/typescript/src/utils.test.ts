/**
 * Tests for multimodal message conversion between AG-UI and LangChain formats.
 */

import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import {
  Message,
  UserMessage,
  TextInputContent,
  BinaryInputContent,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
  InputContent,
} from "@ag-ui/client";
import {
  aguiMessagesToLangChain,
  langchainMessagesToAgui,
  resolveReasoningContent,
  AGUI_MULTIMODAL_SIDECAR_KEY,
} from "./utils";

describe("Multimodal Message Conversion", () => {
  describe("aguiMessagesToLangChain", () => {
    it("should convert text-only AG-UI message to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-1",
        role: "user",
        content: "Hello, world!",
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(lcMessages[0].type).toBe("human");
      expect(lcMessages[0].content).toBe("Hello, world!");
      expect(lcMessages[0].id).toBe("test-1");
    });

    it("should convert ImageInputContent with URL source to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-img-url",
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.com/photo.jpg",
            },
          } as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(lcMessages[0].type).toBe("human");
      expect(Array.isArray(lcMessages[0].content)).toBe(true);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      expect(content[0].type).toBe("text");
      expect(content[0].text).toBe("What's in this image?");

      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/photo.jpg");
    });

    it("should convert ImageInputContent with data source to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-img-data",
        role: "user",
        content: [
          { type: "text", text: "Analyze this" },
          {
            type: "image",
            source: {
              type: "data",
              value: "iVBORw0KGgoAAAANSUhEUgAAAAUA",
              mimeType: "image/png",
            },
          } as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(Array.isArray(lcMessages[0].content)).toBe(true);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      const imageContent = content[1];
      expect(imageContent.type).toBe("image_url");
      expect(imageContent.image_url.url).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"
      );
    });

    it("should convert AudioInputContent to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-audio",
        role: "user",
        content: [
          { type: "text", text: "Transcribe this audio" },
          {
            type: "audio",
            source: {
              type: "url",
              value: "https://example.com/audio.mp3",
            },
          } as AudioInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/audio.mp3");
    });

    it("should convert VideoInputContent to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-video",
        role: "user",
        content: [
          { type: "text", text: "Describe this video" },
          {
            type: "video",
            source: {
              type: "data",
              value: "dmlkZW9kYXRh",
              mimeType: "video/mp4",
            },
          } as VideoInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe(
        "data:video/mp4;base64,dmlkZW9kYXRh"
      );
    });

    it("should convert DocumentInputContent to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-doc",
        role: "user",
        content: [
          { type: "text", text: "Summarize this document" },
          {
            type: "document",
            source: {
              type: "url",
              value: "https://example.com/doc.pdf",
            },
          } as DocumentInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/doc.pdf");
    });

    it("should handle BinaryInputContent for backwards compatibility", () => {
      const aguiMessage: UserMessage = {
        id: "test-binary-compat",
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            url: "https://example.com/photo.jpg",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/photo.jpg");
    });

    it("should handle BinaryInputContent with base64 data for backwards compat", () => {
      const aguiMessage: UserMessage = {
        id: "test-binary-data",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAUA",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("image_url");
      expect(content[0].image_url.url).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"
      );
    });
  });

  describe("langchainMessagesToAgui", () => {
    it("should convert text-only LangChain message to AG-UI", () => {
      const lcMessage: LangGraphMessage = {
        id: "test-4",
        type: "human",
        content: "Hello from LangChain",
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      expect(aguiMessages).toHaveLength(1);
      expect(aguiMessages[0].role).toBe("user");
      expect(aguiMessages[0].content).toBe("Hello from LangChain");
    });

    it("should convert LangChain image_url to ImageInputContent with URL source", () => {
      const lcMessage: LangGraphMessage = {
        id: "test-lc-url",
        type: "human",
        content: [
          { type: "text", text: "What do you see?" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/image.jpg" },
          },
        ] as any,
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      expect(aguiMessages).toHaveLength(1);
      expect(aguiMessages[0].role).toBe("user");
      expect(Array.isArray(aguiMessages[0].content)).toBe(true);

      const content = aguiMessages[0].content as Array<TextInputContent | ImageInputContent>;
      expect(content).toHaveLength(2);

      // Check text content
      expect(content[0].type).toBe("text");
      expect((content[0] as TextInputContent).text).toBe("What do you see?");

      // Check image content - should now be ImageInputContent with URL source
      const imageContent = content[1] as ImageInputContent;
      expect(imageContent.type).toBe("image");
      expect(imageContent.source.type).toBe("url");
      expect((imageContent.source as { type: "url"; value: string }).value).toBe(
        "https://example.com/image.jpg"
      );
    });

    it("should convert LangChain data URL to ImageInputContent with data source", () => {
      const lcMessage: LangGraphMessage = {
        id: "test-lc-data",
        type: "human",
        content: [
          { type: "text", text: "Check this out" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo" },
          },
        ] as any,
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      expect(aguiMessages).toHaveLength(1);
      expect(Array.isArray(aguiMessages[0].content)).toBe(true);

      const content = aguiMessages[0].content as Array<TextInputContent | ImageInputContent>;
      expect(content).toHaveLength(2);

      // Check that data URL was parsed correctly into ImageInputContent
      const imageContent = content[1] as ImageInputContent;
      expect(imageContent.type).toBe("image");
      expect(imageContent.source.type).toBe("data");

      const dataSource = imageContent.source as { type: "data"; value: string; mimeType: string };
      expect(dataSource.value).toBe("iVBORw0KGgo");
      expect(dataSource.mimeType).toBe("image/png");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty content arrays", () => {
      const aguiMessage: UserMessage = {
        id: "test-7",
        role: "user",
        content: [],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(Array.isArray(lcMessages[0].content)).toBe(true);
      expect((lcMessages[0].content as Array<any>)).toHaveLength(0);
    });

    it("should handle BinaryInputContent with only id for backwards compat", () => {
      const aguiMessage: UserMessage = {
        id: "test-8",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/jpeg",
            id: "img-123",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("image_url");
      expect(content[0].image_url.url).toBe("img-123");
    });

    it("should skip media content with unknown source type", () => {
      const aguiMessage: UserMessage = {
        id: "test-unknown-source",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "image",
            source: { type: "unknown" as any, value: "foo" },
          } as any,
        ],
      };
      const lcMessages = aguiMessagesToLangChain([aguiMessage]);
      const content = lcMessages[0].content as Array<any>;
      // Only text should remain, image with unknown source should be dropped
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
    });

    it("should skip binary content without any source", () => {
      const aguiMessage: UserMessage = {
        id: "test-9",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            // No url, data, or id
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      // Binary content should be skipped, only text remains
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
    });
  });

  describe("Provider-safe multimodal sidecar", () => {
    // Helper: read the sidecar off a converted human message's response_metadata.
    const sidecarOf = (message: LangGraphMessage): unknown => {
      const responseMetadata = (message as { response_metadata?: Record<string, unknown> })
        .response_metadata;
      return responseMetadata?.[AGUI_MULTIMODAL_SIDECAR_KEY];
    };

    describe("forward: provider-safe blocks + response_metadata sidecar", () => {
      it("emits legacy blocks with no metadata key and records the sidecar on response_metadata", () => {
        const aguiMessage: UserMessage = {
          id: "fwd-image",
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "url", value: "https://example.com/photo.jpg" },
              metadata: { alt: "a cat", id: 42 },
            } as ImageInputContent,
          ],
        };

        const lcMessages = aguiMessagesToLangChain([aguiMessage]);

        const blocks = lcMessages[0].content as Array<any>;
        // The model-bound image block is a plain legacy image_url with no
        // AG-UI metadata leaking onto it.
        expect(blocks[1]).toEqual({
          type: "image_url",
          image_url: { url: "https://example.com/photo.jpg" },
        });
        expect(blocks[1]).not.toHaveProperty("metadata");
        expect(blocks[0]).not.toHaveProperty("metadata");

        // Type + metadata live out-of-band in the aligned sidecar.
        expect(sidecarOf(lcMessages[0])).toEqual([
          null,
          { type: "image", metadata: { alt: "a cat", id: 42 } },
        ]);
      });

      it("records the media type even when no metadata is present", () => {
        const aguiMessage: UserMessage = {
          id: "fwd-audio",
          role: "user",
          content: [
            {
              type: "audio",
              source: { type: "url", value: "https://example.com/a.mp3" },
            } as AudioInputContent,
          ],
        };

        const lcMessages = aguiMessagesToLangChain([aguiMessage]);

        const blocks = lcMessages[0].content as Array<any>;
        expect(blocks[0]).not.toHaveProperty("metadata");
        // No metadata key when the source block had none.
        expect(sidecarOf(lcMessages[0])).toEqual([{ type: "audio" }]);
      });

      it.each([
        { type: "image", value: "https://example.com/i.jpg" },
        { type: "audio", value: "https://example.com/a.mp3" },
        { type: "video", value: "https://example.com/v.mp4" },
        { type: "document", value: "https://example.com/d.pdf" },
      ])(
        "emits a provider-safe block and a typed sidecar entry for $type",
        ({ type, value }) => {
          const aguiMessage: UserMessage = {
            id: `fwd-${type}`,
            role: "user",
            content: [
              {
                type,
                source: { type: "url", value },
                metadata: { k: type },
              } as InputContent,
            ],
          };

          const lcMessages = aguiMessagesToLangChain([aguiMessage]);

          const blocks = lcMessages[0].content as Array<any>;
          expect(blocks[0]).toEqual({ type: "image_url", image_url: { url: value } });
          expect(blocks[0]).not.toHaveProperty("metadata");
          expect(sidecarOf(lcMessages[0])).toEqual([{ type, metadata: { k: type } }]);
        }
      );

      it("does not attach a sidecar to text-only content", () => {
        const aguiMessage: UserMessage = {
          id: "fwd-text-only",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        };

        const lcMessages = aguiMessagesToLangChain([aguiMessage]);
        expect(sidecarOf(lcMessages[0])).toBeUndefined();
      });

      it("does not attach a sidecar to legacy-binary-only content", () => {
        const aguiMessage: UserMessage = {
          id: "fwd-binary-only",
          role: "user",
          content: [
            {
              type: "binary",
              mimeType: "image/jpeg",
              url: "https://example.com/photo.jpg",
            } as BinaryInputContent,
          ],
        };

        const lcMessages = aguiMessagesToLangChain([aguiMessage]);
        const blocks = lcMessages[0].content as Array<any>;
        expect(blocks[0]).not.toHaveProperty("metadata");
        expect(sidecarOf(lcMessages[0])).toBeUndefined();
      });
    });

    describe("reverse: sidecar restores type + metadata, falls back safely", () => {
      it("restores type + metadata from the sidecar", () => {
        const lcMessage = {
          id: "rev-tagged",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/v.mp4" } },
          ],
          response_metadata: {
            [AGUI_MULTIMODAL_SIDECAR_KEY]: [{ type: "video", metadata: { fps: 30 } }],
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[0];
        expect(part.type).toBe("video");
        expect(part.source).toEqual({ type: "url", value: "https://example.com/v.mp4" });
        expect(part.metadata).toEqual({ fps: 30 });
      });

      it("falls back to image with no metadata when the sidecar is missing", () => {
        const lcMessage = {
          id: "rev-untagged",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[0];
        expect(part.type).toBe("image");
        expect(part.metadata).toBeUndefined();
      });

      it("ignores a wrong-length sidecar and falls back to legacy behavior", () => {
        const lcMessage = {
          id: "rev-wrong-length",
          type: "human",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
          // Length 1 but content has 2 blocks -> misaligned -> rejected.
          response_metadata: {
            [AGUI_MULTIMODAL_SIDECAR_KEY]: [{ type: "video" }],
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[1];
        expect(part.type).toBe("image");
        expect(part.metadata).toBeUndefined();
      });

      it("ignores a longer-than-content sidecar and falls back to legacy behavior", () => {
        const lcMessage = {
          id: "rev-too-long",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
          // Length 2 but content has 1 block -> misaligned -> rejected.
          response_metadata: {
            [AGUI_MULTIMODAL_SIDECAR_KEY]: [{ type: "video" }, { type: "audio" }],
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[0];
        expect(part.type).toBe("image");
        expect(part.metadata).toBeUndefined();
      });

      it("ignores a non-object response_metadata and falls back to legacy behavior", () => {
        const lcMessage = {
          id: "rev-bad-response-metadata",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
          response_metadata: "oops",
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[0];
        expect(part.type).toBe("image");
        expect(part.metadata).toBeUndefined();
      });

      it("ignores a non-array sidecar and falls back to legacy behavior", () => {
        const lcMessage = {
          id: "rev-non-array",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
          response_metadata: {
            [AGUI_MULTIMODAL_SIDECAR_KEY]: { type: "video" },
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[0];
        expect(part.type).toBe("image");
        expect(part.metadata).toBeUndefined();
      });

      it("ignores a sidecar with an invalid entry type and falls back for all blocks", () => {
        const lcMessage = {
          id: "rev-invalid-type",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/a.mp3" } },
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
          response_metadata: {
            // First entry has a non-media type -> whole sidecar rejected.
            [AGUI_MULTIMODAL_SIDECAR_KEY]: [{ type: "binary" }, { type: "image" }],
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const content = aguiMessages[0].content as Array<any>;
        expect(content[0].type).toBe("image");
        expect(content[0].metadata).toBeUndefined();
        expect(content[1].type).toBe("image");
        expect(content[1].metadata).toBeUndefined();
      });

      it("ignores a malformed sidecar entry (string instead of null/record)", () => {
        const lcMessage = {
          id: "rev-malformed-entry",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
          ],
          response_metadata: {
            [AGUI_MULTIMODAL_SIDECAR_KEY]: ["video"],
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const part = (aguiMessages[0].content as Array<any>)[0];
        expect(part.type).toBe("image");
        expect(part.metadata).toBeUndefined();
      });

      it("keeps text/media index alignment when reading the sidecar", () => {
        const lcMessage = {
          id: "rev-alignment",
          type: "human",
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "https://example.com/a.mp3" } },
            { type: "text", text: "second" },
            { type: "image_url", image_url: { url: "https://example.com/d.pdf" } },
          ],
          response_metadata: {
            [AGUI_MULTIMODAL_SIDECAR_KEY]: [
              null,
              { type: "audio", metadata: { lang: "en" } },
              null,
              { type: "document" },
            ],
          },
        } as unknown as LangGraphMessage;

        const aguiMessages = langchainMessagesToAgui([lcMessage]);

        const content = aguiMessages[0].content as Array<any>;
        expect(content).toHaveLength(4);
        expect(content[0]).toEqual({ type: "text", text: "first" });
        expect(content[1].type).toBe("audio");
        expect(content[1].metadata).toEqual({ lang: "en" });
        expect(content[2]).toEqual({ type: "text", text: "second" });
        expect(content[3].type).toBe("document");
        expect(content[3].metadata).toBeUndefined();
      });
    });

    describe("round-trip survives a JSON checkpoint", () => {
      const roundTripFixtures = [
        {
          type: "image",
          source: { type: "url", value: "https://example.com/image.jpg" },
        },
        {
          type: "image",
          source: { type: "data", value: "aW1hZ2U=", mimeType: "image/jpeg" },
        },
        {
          type: "audio",
          source: { type: "url", value: "https://example.com/audio.mp3" },
        },
        {
          type: "audio",
          source: { type: "data", value: "YXVkaW8=", mimeType: "audio/mpeg" },
        },
        {
          type: "video",
          source: { type: "url", value: "https://example.com/video.mp4" },
        },
        {
          type: "video",
          source: { type: "data", value: "dmlkZW8=", mimeType: "video/mp4" },
        },
        {
          type: "document",
          source: { type: "url", value: "https://example.com/document.pdf" },
        },
        {
          type: "document",
          source: { type: "data", value: "ZG9jdW1lbnQ=", mimeType: "application/pdf" },
        },
      ] satisfies InputContent[];

      it.each(roundTripFixtures)(
        "round-trips $type ($source.type) through a stringify/parse checkpoint preserving metadata",
        (mediaContent) => {
          const metadata = { kind: mediaContent.type, sourceType: mediaContent.source.type, n: 7 };
          const original: UserMessage = {
            id: `rt-${mediaContent.type}-${mediaContent.source.type}`,
            role: "user",
            content: [{ ...mediaContent, metadata }],
          };

          const lcMessages = aguiMessagesToLangChain([original]);
          // The model-bound block is a plain legacy image_url with no metadata.
          expect((lcMessages[0].content as Array<any>)[0]).not.toHaveProperty("metadata");

          // Simulate the LangGraph checkpoint JSON round-trip.
          const persisted = JSON.parse(JSON.stringify(lcMessages[0])) as LangGraphMessage;
          // The sidecar survives serialization on response_metadata.
          expect(sidecarOf(persisted)).toEqual([{ type: mediaContent.type, metadata }]);

          const roundTripped = langchainMessagesToAgui([persisted]);

          const part = (roundTripped[0].content as Array<any>)[0];
          expect(part.type).toBe(mediaContent.type);
          expect(part.source).toEqual(mediaContent.source);
          expect(part.metadata).toEqual(metadata);
        }
      );

      it("preserves text/media index alignment across a checkpoint round-trip", () => {
        const original: UserMessage = {
          id: "rt-alignment",
          role: "user",
          content: [
            { type: "text", text: "first" },
            {
              type: "audio",
              source: { type: "url", value: "https://example.com/a.mp3" },
              metadata: { lang: "en" },
            } as AudioInputContent,
            { type: "text", text: "second" },
            {
              type: "document",
              source: { type: "url", value: "https://example.com/d.pdf" },
            } as DocumentInputContent,
          ],
        };

        const lcMessages = aguiMessagesToLangChain([original]);
        for (const block of lcMessages[0].content as Array<any>) {
          expect(block).not.toHaveProperty("metadata");
        }

        const persisted = JSON.parse(JSON.stringify(lcMessages[0])) as LangGraphMessage;
        expect(sidecarOf(persisted)).toEqual([
          null,
          { type: "audio", metadata: { lang: "en" } },
          null,
          { type: "document" },
        ]);

        const roundTripped = langchainMessagesToAgui([persisted]);
        const content = roundTripped[0].content as Array<any>;
        expect(content).toHaveLength(4);
        expect(content[0]).toEqual({ type: "text", text: "first" });
        expect(content[1].type).toBe("audio");
        expect(content[1].metadata).toEqual({ lang: "en" });
        expect(content[2]).toEqual({ type: "text", text: "second" });
        expect(content[3].type).toBe("document");
        expect(content[3].metadata).toBeUndefined();
      });

      it.each([
        { label: "primitive string", metadata: "just a string" },
        { label: "primitive number", metadata: 0 },
        { label: "primitive boolean", metadata: false },
        { label: "primitive null", metadata: null },
        { label: "array", metadata: [1, "two", { three: 3 }] },
        {
          label: "object with a user-owned __agui_type key",
          metadata: { __agui_type: "user-owned", note: "not touched" },
        },
      ])(
        "preserves arbitrary metadata ($label) across a checkpoint round-trip",
        ({ metadata }) => {
          const original: UserMessage = {
            id: "rt-arbitrary-metadata",
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", value: "https://example.com/photo.jpg" },
                metadata,
              } as ImageInputContent,
            ],
          };

          const lcMessages = aguiMessagesToLangChain([original]);
          // The model-bound block never carries the metadata.
          expect((lcMessages[0].content as Array<any>)[0]).not.toHaveProperty("metadata");

          const persisted = JSON.parse(JSON.stringify(lcMessages[0])) as LangGraphMessage;
          const roundTripped = langchainMessagesToAgui([persisted]);

          const part = (roundTripped[0].content as Array<any>)[0];
          expect(part.type).toBe("image");
          expect(part.metadata).toEqual(metadata);
        }
      );
    });
  });
});

describe("resolveReasoningContent - DeepSeek-style reasoning_content", () => {
  it("should return LangGraphReasoning when reasoning_content is a non-empty string", () => {
    const eventData = {
      chunk: {
        content: null,
        additional_kwargs: { reasoning_content: "thinking step by step" },
      },
    };

    const result = resolveReasoningContent(eventData);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("text");
    expect(result!.text).toBe("thinking step by step");
    expect(result!.index).toBe(0);
  });

  it("should return null when reasoning_content is empty string", () => {
    const eventData = {
      chunk: {
        content: null,
        additional_kwargs: { reasoning_content: "" },
      },
    };

    expect(resolveReasoningContent(eventData)).toBeNull();
  });

  it("should return null when reasoning_content is not present", () => {
    const eventData = {
      chunk: {
        content: null,
        additional_kwargs: { some_other_key: "value" },
      },
    };

    expect(resolveReasoningContent(eventData)).toBeNull();
  });

  it("should prioritize content block formats over additional_kwargs.reasoning_content", () => {
    const eventData = {
      chunk: {
        content: [{ type: "thinking", thinking: "from content block" }],
        additional_kwargs: { reasoning_content: "from additional_kwargs" },
      },
    };

    const result = resolveReasoningContent(eventData);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("from content block");
  });
});
