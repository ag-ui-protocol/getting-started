/**
 * Tests for multimodal message conversion between AG-UI and LangChain formats.
 */

import { readFileSync } from "node:fs";
import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import {
  Message,
  UserMessage,
  TextInputContent,
  InputContent,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
} from "@ag-ui/client";
// Imported at the TOP LEVEL, not dynamically inside the boundary tests below.
// `@langchain/openai` pulls a large module graph, and on a cold CI runner the
// first `await import()` of it took 7.9s — charged to the test that happened to
// run first, which then failed vitest's 5s default while the later ones passed
// on the warm cache. File-level import time is not charged to a test.
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { aguiMessagesToLangChain, langchainMessagesToAgui, resolveReasoningContent } from "./utils";

// The legacy binary part left @ag-ui/core in 1.0; this boundary still reads
// it (see utils.ts), so the tests type it locally.
//
// Hence the `as LegacyBinaryInputContent as unknown as InputContent` on the fixtures
// below, which is two different things in one line.
//
// `as unknown as InputContent` is the half the compiler requires: 1.0's
// InputContent union has no `binary` member, so a direct cast is an error and
// TypeScript's own advice is to launder through `unknown`. On its own it would
// build — `{}` would too, which is the point of the other half.
//
// `as LegacyBinaryInputContent` names what the literal is SUPPOSED to be, so a typo'd
// `mimetype` or a numeric `mimeType` fails to compile instead of quietly
// becoming a free-form object. Today every test here also pins its own output
// tightly enough to catch that, so this half is a guard rail rather than a
// load-bearing check — keep it when adding a fixture whose assertion is only
// that the part was DROPPED, where a malformed literal would be dropped too and
// the test would pass for the wrong reason.
interface LegacyBinaryInputContent {
  type: "binary";
  mimeType: string;
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
}

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

    it("should convert AudioInputContent with inline data to an audio block", () => {
      const aguiMessage: UserMessage = {
        id: "test-audio-data",
        role: "user",
        content: [
          { type: "text", text: "Transcribe this audio" },
          {
            type: "audio",
            source: {
              type: "data",
              value: "SGVsbG8=",
              mimeType: "audio/wav",
            },
          } as AudioInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      // An `audio` block, NOT `image_url`: providers validate the block kind, so
      // audio announced as an image is rejected outright. Base64 audio is one of
      // the two combinations both translators accept — see the boundary test
      // "carries an emitted audio block to OpenAI as an input_audio part".
      expect(content[1]).toEqual({
        type: "audio",
        source_type: "base64",
        data: "SGVsbG8=",
        mime_type: "audio/wav",
      });
    });

    // ── Combinations deliberately LEFT on the legacy `image_url` path ────────
    //
    // These are pinned decisions, not aspirations. For each one, the standard
    // media block THROWS inside the translator, so emitting it would convert the
    // pre-existing degraded request into a dead run. They stay on `image_url`
    // until the translators accept them. Do not "finish the job" by flipping one
    // of these without re-measuring the boundary first.

    it("keeps audio by URL on the legacy image_url path", () => {
      // JS: "URL audio blocks with source_type url must be formatted as a data
      // URL for ChatOpenAI". Python: ValueError "Key base64 is required for audio
      // blocks".
      const aguiMessage: UserMessage = {
        id: "test-audio-url",
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
      expect(content[1]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/audio.mp3" },
      });
    });

    it("keeps video on the legacy image_url path, whatever the source", () => {
      // JS: "Unable to convert content block type 'video' to provider-specific
      // format: not recognized." Python: ValueError "Block of type video is not
      // supported." Neither source type changes that.
      const aguiMessage: UserMessage = {
        id: "test-video",
        role: "user",
        content: [
          {
            type: "video",
            source: {
              type: "data",
              value: "dmlkZW9kYXRh",
              mimeType: "video/mp4",
            },
          } as VideoInputContent,
          {
            type: "video",
            source: {
              type: "url",
              value: "https://example.com/clip.mp4",
            },
          } as VideoInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toEqual([
        { type: "image_url", image_url: { url: "data:video/mp4;base64,dmlkZW9kYXRh" } },
        { type: "image_url", image_url: { url: "https://example.com/clip.mp4" } },
      ]);
    });

    it("keeps documents by URL on the legacy image_url path", () => {
      // JS: "URL file blocks with source_type url must be formatted as a data URL
      // for ChatOpenAI". Python: ValueError "OpenAI Chat Completions does not
      // support file URLs." Fetching the bytes on the caller's behalf is not this
      // adapter's job, so the URL keeps going out as it always did.
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
            metadata: { filename: "doc.pdf" },
          } as DocumentInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1]).toEqual({
        type: "image_url",
        image_url: { url: "https://example.com/doc.pdf" },
      });
    });

    it("keeps a legacy binary by URL on the legacy image_url path", () => {
      // Same rule as the typed items above: only inline data converts.
      const aguiMessage: UserMessage = {
        id: "test-binary-pdf-url",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "application/pdf",
            url: "https://example.com/legacy.pdf",
            filename: "legacy.pdf",
          } as LegacyBinaryInputContent as unknown as InputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toEqual([
        { type: "image_url", image_url: { url: "https://example.com/legacy.pdf" } },
      ]);
    });

    it("should send an attached PDF as a file block, not an image", () => {
      // THE REGRESSION THIS GUARDS. A PDF handed to a provider as `image_url` —
      // with `application/pdf` sitting inside the data URL — is rejected on the
      // block kind:
      //
      //     BadRequestError: 400 - Invalid MIME type. Only image types are
      //     supported. (code: invalid_image_format)
      //
      // and the exception kills the run rather than degrading it.
      const aguiMessage: UserMessage = {
        id: "test-doc-data",
        role: "user",
        content: [
          { type: "text", text: "Summarize this invoice" },
          {
            type: "document",
            source: {
              type: "data",
              value: "JVBERi0xLjQK",
              mimeType: "application/pdf",
            },
            metadata: { filename: "invoice-q2.pdf" },
          } as DocumentInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content[1]).toEqual({
        type: "file",
        source_type: "base64",
        data: "JVBERi0xLjQK",
        mime_type: "application/pdf",
        // `source_type` is the recognition key — the JS default conversion path
        // gates translation behind `isDataContentBlock`, which tests for exactly
        // that field. `filename` sits under `metadata` because that is where
        // BOTH runtimes look (JS `getRequiredFilenameFromMetadata`, Python
        // `convert_to_openai_data_block`'s backward-compat branch); without it
        // the JS translator THROWS.
        metadata: { filename: "invoice-q2.pdf" },
      });
      // Issue #2100 restated rather than dropped. The block DOES carry a
      // `metadata` key now, because that is the native home for the filename —
      // but only `filename`, never AG-UI's metadata object wholesale, which is
      // what made strict providers 400.
      expect(Object.keys(content[1].metadata)).toEqual(["filename"]);
    });

    it("derives a filename for a document that arrived without one", () => {
      // NOT cosmetic. `@langchain/openai` throws on a file block with no filename
      // ("a filename or name or title is needed via meta-data for OpenAI when
      // working with multimodal blocks"), so a document without one would land on
      // the very failure this narrowing exists to avoid. The substitute comes
      // from the MIME subtype and is applied in both runtimes so they agree.
      const aguiMessage: UserMessage = {
        id: "test-doc-no-filename",
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "data",
              value: "JVBERi0xLjQK",
              mimeType: "application/pdf",
            },
          } as DocumentInputContent,
        ],
      };

      const content = aguiMessagesToLangChain([aguiMessage])[0].content as Array<any>;
      expect(content[0]).toEqual({
        type: "file",
        source_type: "base64",
        data: "JVBERi0xLjQK",
        mime_type: "application/pdf",
        metadata: { filename: "attachment.pdf" },
      });
    });

    // THE SUBTYPE IS NOT THE EXTENSION. It coincides with one often enough that
    // `mime.split("/")[1]` looks like a rule, and the rows below are where that
    // rule was wrong: `text/plain` is not `.plain`, `audio/mpeg` is not `.mpeg`,
    // `application/vnd.api+json` is not `.vnd.api`. The passthrough rows are
    // here so the fix cannot be a lookup table that forgot the common case.
    //
    // Every row is duplicated in the Python suite
    // (`test_derived_filename_extensions`). A row that disagrees across the two
    // is an attachment that reaches the provider under a different name
    // depending on which runtime sent it — the class of bug this branch closes.
    it.each([
      // Corrected by the extension map.
      ["text/plain", "attachment.txt"],
      ["text/markdown", "attachment.md"],
      ["audio/mpeg", "attachment.mp3"],
      ["application/msword", "attachment.doc"],
      ["application/vnd.ms-excel", "attachment.xls"],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "attachment.docx",
      ],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "attachment.xlsx"],
      ["image/jpeg", "attachment.jpg"],
      // Structured-syntax suffix: the format is what follows the `+`.
      ["application/vnd.api+json", "attachment.json"],
      ["application/ld+json", "attachment.json"],
      // Registration tree stripped: `vnd.` / `prs.` / `x-` / `x.` are
      // NAMESPACES, and leaving one on turns a perfectly good extension into an
      // implausible one that falls back to `.bin`. These rows are the only ones
      // where the strip changes the answer — `application/x-weird-thing` below
      // is `.bin` with or without it — so without them the strip is deletable
      // with both suites green.
      ["application/x-tar", "attachment.tar"],
      ["application/vnd.rar", "attachment.rar"],
      ["application/prs.foo", "attachment.foo"],
      ["application/x.custom", "attachment.custom"],
      // Already right from the subtype, and must stay right.
      ["application/pdf", "attachment.pdf"],
      ["text/csv", "attachment.csv"],
      ["application/json", "attachment.json"],
      ["text/html", "attachment.html"],
      ["application/zip", "attachment.zip"],
      // Nothing plausible to extract: an unidentified byte stream is `.bin`.
      ["application/octet-stream", "attachment.bin"],
      ["application/x-weird-thing", "attachment.bin"],
      ["application/vnd.acme.internal-thing", "attachment.bin"],
      // Malformed. `a/b/c` has no subtype, and the middle segment is not one —
      // the two runtimes must not disagree about that.
      ["application/pdf/extra", "attachment.bin"],
      ["notamimetype", "attachment.bin"],
      // MIME types are case-insensitive (RFC 2045 §5.1), and parameters are not
      // part of the type's identity.
      ["TEXT/PLAIN", "attachment.txt"],
      ["text/plain; charset=utf-8", "attachment.txt"],
    ])("derives %s as %s", (mimeType, expected) => {
      const content = aguiMessagesToLangChain([
        {
          id: "test-derive",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "JVBERi0xLjQK", mimeType },
            } as DocumentInputContent,
          ],
        } as UserMessage,
      ])[0].content as Array<any>;

      expect(content[0].metadata).toEqual({ filename: expected });
    });

    it("treats an empty supplied filename as absent, not as a name", () => {
      // `""` is not a name the client chose, it is a name the client failed to
      // send. Reading it with `??` accepts it, skips the derivation, and emits a
      // file block with NO filename — which is the one shape
      // `@langchain/openai` throws on. Both entry points are pinned: the typed
      // `metadata.filename` and the legacy item's top-level `filename`.
      const content = aguiMessagesToLangChain([
        {
          id: "test-empty-filename",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
              metadata: { filename: "" },
            } as DocumentInputContent,
            {
              type: "binary",
              mimeType: "application/pdf",
              data: "JVBERi0xLjQK",
              filename: "",
            } as LegacyBinaryInputContent as unknown as InputContent,
          ],
        } as UserMessage,
      ])[0].content as Array<any>;

      expect(content[0].metadata).toEqual({ filename: "attachment.pdf" });
      expect(content[1].metadata).toEqual({ filename: "attachment.pdf" });
    });

    it("should keep a document a document across the LangChain round trip", () => {
      // This is the MESSAGES_SNAPSHOT path. A block kind the return leg does not
      // understand is an attachment that disappears from the thread on the next
      // snapshot: the file was sent, the model read it, and a reopened thread
      // shows a bare line of text.
      const aguiMessage: UserMessage = {
        id: "test-doc-roundtrip",
        role: "user",
        content: [
          { type: "text", text: "Summarize this invoice" },
          {
            type: "document",
            source: {
              type: "data",
              value: "JVBERi0xLjQK",
              mimeType: "application/pdf",
            },
            metadata: { filename: "invoice-q2.pdf" },
          } as DocumentInputContent,
        ],
      };

      const roundTripped = langchainMessagesToAgui(
        aguiMessagesToLangChain([aguiMessage])
      );

      const content = (roundTripped[0] as UserMessage).content as Array<any>;
      expect(content[1]).toEqual({
        type: "document",
        source: {
          type: "data",
          value: "JVBERi0xLjQK",
          mimeType: "application/pdf",
        },
        metadata: { filename: "invoice-q2.pdf" },
      });
    });

    it("should send a legacy binary PDF as a file block", () => {
      // `LegacyBinaryInputContent` is deprecated but still accepted, and a deprecated
      // path that 400s is not meaningfully more supported than one that raises.
      const aguiMessage: UserMessage = {
        id: "test-binary-pdf",
        role: "user",
        content: [
          { type: "text", text: "Summarize this" },
          {
            type: "binary",
            mimeType: "application/pdf",
            data: "JVBERi0xLjQK",
            filename: "legacy-invoice.pdf",
          } as LegacyBinaryInputContent as unknown as InputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content[1]).toEqual({
        type: "file",
        source_type: "base64",
        data: "JVBERi0xLjQK",
        mime_type: "application/pdf",
        metadata: { filename: "legacy-invoice.pdf" },
      });
    });

    it("should handle LegacyBinaryInputContent for backwards compatibility", () => {
      const aguiMessage: UserMessage = {
        id: "test-binary-compat",
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            url: "https://example.com/photo.jpg",
          } as LegacyBinaryInputContent as unknown as InputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/photo.jpg");
    });

    it("should handle LegacyBinaryInputContent with base64 data for backwards compat", () => {
      const aguiMessage: UserMessage = {
        id: "test-binary-data",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAUA",
          } as LegacyBinaryInputContent as unknown as InputContent,
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

  // ── Modality survives the `image_url` round trip ──────────────────────────
  //
  // `image_url` is the fallback block for every modality the outbound leg cannot
  // send as a standard block — video always, audio outside the provider's format
  // enum, and every URL-sourced item — so reading the block kind literally on the
  // way back rewrote the thread: the user attached a video and MESSAGES_SNAPSHOT
  // came back holding an image, permanently, for every later read.
  //
  // The MIME type inside the data URL is the recovery signal, and these tests
  // pin BOTH halves: the type that comes back, and the fact that the block going
  // out is byte-for-byte what it was (the outbound shape is provider-measured and
  // must not move).
  describe("modality survives the image_url round trip", () => {
    const roundTrip = (item: any) => {
      const lc = aguiMessagesToLangChain([
        { id: "rt", role: "user", content: [item] } as UserMessage,
      ]);
      const agui = langchainMessagesToAgui(lc);
      return {
        wire: (lc[0].content as Array<any>)[0],
        content: ((agui[0] as UserMessage).content as Array<any>)[0],
      };
    };

    it("keeps a video a video across the round trip", () => {
      const { wire, content } = roundTrip({
        type: "video",
        source: { type: "data", value: "SGVsbG8=", mimeType: "video/mp4" },
        metadata: { filename: "clip.mp4" },
      } as VideoInputContent);

      // Unchanged on the wire: video still has no standard block that any
      // translator accepts, so it stays on `image_url` deliberately.
      expect(wire).toEqual({
        type: "image_url",
        image_url: { url: "data:video/mp4;base64,SGVsbG8=" },
      });
      expect(content).toEqual({
        type: "video",
        source: { type: "data", value: "SGVsbG8=", mimeType: "video/mp4" },
      });
    });

    it("keeps audio the provider cannot carry an audio across the round trip", () => {
      // `audio/ogg` is outside `input_audio.format`, so it rides `image_url` too.
      const { wire, content } = roundTrip({
        type: "audio",
        source: { type: "data", value: "SGVsbG8=", mimeType: "audio/ogg" },
      } as AudioInputContent);

      expect(wire).toEqual({
        type: "image_url",
        image_url: { url: "data:audio/ogg;base64,SGVsbG8=" },
      });
      expect(content).toEqual({
        type: "audio",
        source: { type: "data", value: "SGVsbG8=", mimeType: "audio/ogg" },
      });
    });

    it("keeps a legacy binary video a video across the round trip", () => {
      const { wire, content } = roundTrip({
        type: "binary",
        mimeType: "video/mp4",
        data: "SGVsbG8=",
      } as LegacyBinaryInputContent);

      expect(wire).toEqual({
        type: "image_url",
        image_url: { url: "data:video/mp4;base64,SGVsbG8=" },
      });
      expect(content).toEqual({
        type: "video",
        source: { type: "data", value: "SGVsbG8=", mimeType: "video/mp4" },
      });
    });

    it("still brings a genuine image back as an image", () => {
      const { content } = roundTrip({
        type: "image",
        source: { type: "data", value: "SGVsbG8=", mimeType: "image/png" },
      } as ImageInputContent);

      expect(content).toEqual({
        type: "image",
        source: { type: "data", value: "SGVsbG8=", mimeType: "image/png" },
      });
    });

    it("reads a non-media MIME type on the image_url path as a document", () => {
      // Nothing in this adapter emits a document as an `image_url` data URL, but a
      // graph relaying its own content can, and `document` is what the legacy
      // binary OUTBOUND leg calls the same MIME type. Symmetry, not guesswork.
      const agui = langchainMessagesToAgui([
        {
          id: "doc-data-url",
          type: "human",
          content: [
            { type: "image_url", image_url: { url: "data:application/pdf;base64,JVBERi0=" } },
          ],
        } as unknown as LangGraphMessage,
      ]);

      expect(((agui[0] as UserMessage).content as Array<any>)[0]).toEqual({
        type: "document",
        source: { type: "data", value: "JVBERi0=", mimeType: "application/pdf" },
      });
    });

    it("leaves a data URL with no MIME type an image", () => {
      // Nothing to read, so the pre-existing default stands rather than a guess.
      const agui = langchainMessagesToAgui([
        {
          id: "no-mime",
          type: "human",
          content: [{ type: "image_url", image_url: { url: "data:;base64,SGVsbG8=" } }],
        } as unknown as LangGraphMessage,
      ]);

      expect(((agui[0] as UserMessage).content as Array<any>)[0].type).toBe("image");
    });

    it("KNOWN LIMIT: a URL-sourced video comes back as an image", () => {
      // Not an oversight — an `image_url` block carries `{ url }` and nothing
      // else, so an https-hosted video arrives with no MIME type and no other
      // modality signal. Adding a key to the block is what issue #2100 was about
      // (providers 400 on unexpected keys inside a content block), and a file
      // extension is not a signal on signed or extensionless CDN URLs. This test
      // exists so the limit is visible and a future fix has to change it
      // deliberately.
      const { content } = roundTrip({
        type: "video",
        source: { type: "url", value: "https://example.com/clip.mp4", mimeType: "video/mp4" },
      } as VideoInputContent);

      expect(content).toEqual({
        type: "image",
        source: { type: "url", value: "https://example.com/clip.mp4" },
      });
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

    it("should handle LegacyBinaryInputContent with only id for backwards compat", () => {
      const aguiMessage: UserMessage = {
        id: "test-8",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/jpeg",
            id: "img-123",
          } as LegacyBinaryInputContent as unknown as InputContent,
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
      // The drop is announced, and the announcement is STUBBED: left live it
      // writes to the suite's stderr on every run, which trains everyone
      // reading CI output to ignore a line the converter emits precisely so a
      // vanished attachment is traceable.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Dropping image content: source could not be converted to URL"),
      );
      warn.mockRestore();
    });

    it("should skip binary content without any source", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const aguiMessage: UserMessage = {
        id: "test-9",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            // No url, data, or id
          } as LegacyBinaryInputContent as unknown as InputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      // Binary content should be skipped, only text remains
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Dropping BinaryInputContent: no url, data, or id provided"),
      );
      warn.mockRestore();
    });
  });

  // ── Malformed input from the wire ────────────────────────────────────────
  //
  // Every value these converters read arrives over a wire: AG-UI content from a
  // client's JSON, LangChain content from whatever the LangGraph server relayed
  // out of model or tool output. Neither side is validated at this boundary in
  // TypeScript (Python's Pydantic models reject most of it before it reaches the
  // converter), so a missing key here is a `TypeError` thrown from INSIDE the
  // loop that converts a whole message list — which discards every other message
  // and every other block along with the bad one.
  //
  // The rule these tests pin: a malformed ITEM is dropped with a warning; it
  // never takes down its neighbours, its message, or the conversion.
  describe("malformed input is dropped, not thrown on", () => {
    it("drops a media item with no source instead of throwing", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const aguiMessage: UserMessage = {
        id: "test-no-source",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          // `source` absent entirely — the shape `standardBlockTypeFor` already
          // guards with `source?.type` but `mediaSourceToUrl` did not.
          { type: "image" } as unknown as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      expect(content).toEqual([{ type: "text", text: "Hello" }]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Dropping image content: source could not be converted to URL")
      );
      warn.mockRestore();
    });

    it("keeps the surrounding content when one media item has no source", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const aguiMessage: UserMessage = {
        id: "test-bad-item-neighbours",
        role: "user",
        content: [
          { type: "text", text: "look at these" },
          { type: "audio", source: null } as unknown as AudioInputContent,
          {
            type: "image",
            source: { type: "url", value: "https://example.com/photo.jpg" },
          } as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      // The text and the good image both survive; only the bad item is gone.
      expect(content).toEqual([
        { type: "text", text: "look at these" },
        { type: "image_url", image_url: { url: "https://example.com/photo.jpg" } },
      ]);
      warn.mockRestore();
    });

    it("does not let one bad media item abort a whole multi-message conversion", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const lcMessages = aguiMessagesToLangChain([
        { id: "m1", role: "user", content: "first" } as UserMessage,
        {
          id: "m2",
          role: "user",
          content: [{ type: "document" } as unknown as DocumentInputContent],
        } as UserMessage,
        { id: "m3", role: "user", content: "third" } as UserMessage,
      ]);

      // The messages either side of the bad one are still there.
      expect(lcMessages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(lcMessages[2].content).toBe("third");
      warn.mockRestore();
    });

    it("drops a null entry in an AG-UI content array", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const aguiMessage: UserMessage = {
        id: "test-null-agui-item",
        role: "user",
        content: [
          { type: "text", text: "before" },
          null as unknown as TextInputContent,
          { type: "text", text: "after" },
        ],
      };

      const content = aguiMessagesToLangChain([aguiMessage])[0].content as Array<any>;
      expect(content).toEqual([
        { type: "text", text: "before" },
        { type: "text", text: "after" },
      ]);
      warn.mockRestore();
    });

    it("drops a null entry in an inbound LangChain content array", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agui = langchainMessagesToAgui([
        {
          id: "null-inbound-block",
          type: "human",
          content: [
            { type: "text", text: "before" },
            null,
            { type: "text", text: "after" },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content).toEqual([
        { type: "text", text: "before" },
        { type: "text", text: "after" },
      ]);
      warn.mockRestore();
    });

    it("tolerates a null block when resolving a message's text content", () => {
      // `resolveMessageContent` runs `content.find(c => c.type === "text")` over
      // an array the graph handed back; a null entry there killed the whole
      // conversion before the text block after it was ever looked at.
      const agui = langchainMessagesToAgui([
        {
          id: "null-block-system",
          type: "system",
          content: [null, { type: "text", text: "you are helpful" }],
        } as unknown as LangGraphMessage,
      ]);

      expect(agui).toHaveLength(1);
      expect(agui[0].content).toBe("you are helpful");
    });

    it("drops a tool call with no function instead of aborting the conversion", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const lcMessages = aguiMessagesToLangChain([
        {
          id: "assistant-bad-tc",
          role: "assistant",
          content: "calling",
          toolCalls: [
            { id: "tc-broken", type: "function" },
            {
              id: "tc-good",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        } as unknown as Message,
        { id: "after", role: "user", content: "and then" } as UserMessage,
      ]);

      // The conversion completed, and the message after the bad tool call is
      // still present.
      expect(lcMessages.map((m) => m.id)).toEqual(["assistant-bad-tc", "after"]);
      const toolCalls = (lcMessages[0] as any).tool_calls;
      expect(toolCalls).toEqual([
        { id: "tc-good", name: "get_weather", args: { city: "Paris" }, type: "tool_call" },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropping tool call"));
      warn.mockRestore();
    });
  });

  // ── THE MALFORMED-INPUT CONTRACT ─────────────────────────────────────────
  //
  // The three rules written above the two converters in `utils.ts` (and above
  // their mirror images in `ag_ui_langgraph/utils.py`): DROP NEVER RAISE, EVERY
  // DROP IS LOGGED, ONE BAD ITEM COSTS ONLY ITSELF. Everything below asserts one
  // of those three on one branch. Each has a named counterpart in the Python
  // suite's `TestMalformedInputContract`, because the defect these exist to catch
  // is a fix landing in one runtime and not the other — see
  // `../../cross-runtime-parity-cases.json`, which is the same claim made as data.
  //
  // The distinction the second rule turns on: a DROP is logged, a KEPT block is
  // not. An assertion on the return value alone cannot tell a logged drop from a
  // silent one, which is how every past divergence here survived review.
  describe("the malformed-input contract", () => {
    /** Convert one LangChain content array back to AG-UI, capturing warnings. */
    function inbound(content: unknown[]): { content: any[]; warnings: string[] } {
      const warnings: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(String(args[0]));
      });
      try {
        const agui = langchainMessagesToAgui([
          { id: "contract", type: "human", content } as unknown as LangGraphMessage,
        ]);
        const converted = (agui[0] as UserMessage)?.content;
        return { content: Array.isArray(converted) ? converted : [], warnings };
      } finally {
        warn.mockRestore();
      }
    }

    /** Convert one AG-UI content array to LangChain, capturing warnings. */
    function outbound(content: unknown[]): { content: any[]; warnings: string[] } {
      const warnings: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(String(args[0]));
      });
      try {
        const lc = aguiMessagesToLangChain([
          { id: "contract", role: "user", content } as unknown as UserMessage,
        ]);
        const converted = lc[0]?.content;
        return { content: Array.isArray(converted) ? converted : [], warnings };
      } finally {
        warn.mockRestore();
      }
    }

    const textsOf = (content: any[]) => content.map((c) => c.text);

    // ── rule 1: the `image_url` payload ────────────────────────────────────
    it("drops an image_url block whose url is not a string instead of throwing", () => {
      // `{ url: 42 }` is truthy, so the old `item.image_url?.url` read handed a
      // NUMBER to `imageUrl.startsWith("data:")`, which threw a TypeError out of
      // the loop that builds the whole MESSAGES_SNAPSHOT — the client got no
      // messages at all, over one attachment.
      const { content, warnings } = inbound([{ type: "image_url", image_url: { url: 42 } }]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("Dropping image_url block: no usable url in its object payload"),
      ]);
    });

    it.each([
      ["a non-string url", { url: 42 }],
      ["an empty url", { url: "" }],
      ["a null url", { url: null }],
      ["an object url", { url: {} }],
      ["a null payload", null],
      ["a numeric payload", 42],
      ["a boolean payload", true],
      ["an array payload", []],
      ["a url wrapped in an array", ["https://example.com/a.png"]],
      ["an object with no url key", {}],
      ["an empty bare string", ""],
    ])("logs exactly one drop for an image_url block with %s", (_name, payload) => {
      // The QUIET half of the same defect. These never threw — they minted an
      // ImageInputContent whose url is `""`, or dropped the block with nothing
      // said, which is rule 2's failure: an operator watching an attachment
      // vanish from a reopened thread had no string to search for.
      const { content, warnings } = inbound([{ type: "image_url", image_url: payload }]);

      expect(content).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Dropping image_url block");
    });

    it("logs one drop for an image_url block with no payload at all", () => {
      const { content, warnings } = inbound([{ type: "image_url" }]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("Dropping image_url block: no usable url in its undefined payload"),
      ]);
    });

    // ── rule 3 ─────────────────────────────────────────────────────────────
    it("keeps the blocks on either side of an unreadable image_url block", () => {
      // This is why rule 1 is worth a rule at all: the throw did not degrade one
      // attachment, it discarded the two text blocks beside it as well.
      const { content, warnings } = inbound([
        { type: "text", text: "before" },
        { type: "image_url", image_url: { url: 42 } },
        { type: "text", text: "after" },
      ]);

      expect(textsOf(content)).toEqual(["before", "after"]);
      expect(warnings).toHaveLength(1);
    });

    it("keeps every OTHER message when one message carries an unreadable block", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agui = langchainMessagesToAgui([
        { id: "m1", type: "human", content: "before" },
        {
          id: "m2",
          type: "human",
          content: [{ type: "image_url", image_url: { url: 42 } }],
        },
        { id: "m3", type: "human", content: "after" },
      ] as unknown as LangGraphMessage[]);
      warn.mockRestore();

      expect(agui.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(agui[0].content).toBe("before");
      expect(agui[2].content).toBe("after");
    });

    // ── rule 1 + 2: the inbound text branch ────────────────────────────────
    it.each([
      ["a number", 42, "number"],
      ["an object", { a: 1 }, "object"],
      ["a null", null, "null"],
      ["an array", ["x"], "object"],
      ["a boolean", true, "boolean"],
    ])("drops and logs a text block whose text is %s", (_name, text, described) => {
      // The branch was gated on TRUTHINESS, which got both ends wrong: a truthy
      // non-string was emitted VERBATIM into `TextInputContent.text` and failed
      // schema validation downstream, well away from the block that caused it.
      const { content, warnings } = inbound([{ type: "text", text }]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining(`Dropping text block: text is ${described}, not a string`),
      ]);
    });

    it("keeps the blocks on either side of an unusable text block", () => {
      const { content, warnings } = inbound([
        { type: "text", text: "before" },
        { type: "text", text: 42 },
        { type: "text", text: "after" },
      ]);

      expect(textsOf(content)).toEqual(["before", "after"]);
      expect(warnings).toHaveLength(1);
    });

    it.each([
      ["present but empty", { type: "text", text: "" }],
      ["absent", { type: "text" }],
    ])("keeps a text block whose text is %s, and says nothing", (_name, block) => {
      // The OTHER end of the truthiness gate: an empty text is a block Python
      // keeps, and TypeScript dropped it with no log — a rule-2 violation on a
      // block that is not malformed at all. `""` is the value, not a drop, so
      // there must be no warning either.
      const { content, warnings } = inbound([block]);

      expect(content).toEqual([{ type: "text", text: "" }]);
      expect(warnings).toEqual([]);
    });

    // ── rule 2: the drops with no branch of their own ──────────────────────
    it.each([
      ["a kind LangChain adds later", { type: "totally_unknown" }],
      ["no type key at all", { foo: "bar" }],
      ["an empty type", { type: "" }],
      ["a numeric type", { type: 7 }],
      ["a null type", { type: null }],
      ["an array type", { type: [] }],
      ["an object type", { type: {} }],
    ])("logs a drop for an inbound block with %s", (_name, block) => {
      // A block matching NO branch used to fall out of the loop leaving nothing
      // behind — no content item and no log — while every other drop in the same
      // loop said so. That is the drop most worth announcing: the others lose one
      // field of a recognized block, this one loses the attachment whole.
      //
      // The last two also pin rule 1 for Python's benefit: an unhashable `type`
      // raised `TypeError: unhashable type` out of its whole snapshot, where this
      // runtime simply answered `undefined` and dropped the block.
      const { content, warnings } = inbound([block]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("Dropping unsupported content block of type"),
      ]);
    });

    it("keeps the blocks on either side of a block with an unhashable type", () => {
      const { content, warnings } = inbound([
        { type: "text", text: "before" },
        { type: [] },
        { type: "text", text: "after" },
      ]);

      expect(textsOf(content)).toEqual(["before", "after"]);
      expect(warnings).toHaveLength(1);
    });

    // ── recovering a payload the first key failed to carry ─────────────────
    it.each([
      ["a number", 42],
      ["an object", { x: 1 }],
      ["a boolean", true],
      ["the empty string", ""],
    ])("reads base64 when data is %s, rather than dropping the block", (_name, data) => {
      // `data ?? base64` / `data or base64` both stop at a present-but-unusable
      // `data` and never reach the perfectly good `base64` behind it, dropping
      // the whole attachment. Python's converter had exactly this bug with `or`;
      // pinned in both runtimes so a fix to one is not lost on the other.
      const { content, warnings } = inbound([
        { type: "image", data, base64: "QUJD", mime_type: "image/png" },
      ]);

      expect(content).toEqual([
        { type: "image", source: { type: "data", value: "QUJD", mimeType: "image/png" } },
      ]);
      expect(warnings).toEqual([]);
    });

    it("reads url when data is present but unusable", () => {
      const { content, warnings } = inbound([
        { type: "image", data: 42, url: "https://example.com/a.png" },
      ]);

      expect(content).toEqual([
        { type: "image", source: { type: "url", value: "https://example.com/a.png" } },
      ]);
      expect(warnings).toEqual([]);
    });

    it.each([
      ["a non-string url", { type: "image", url: 42 }],
      ["an empty url", { type: "image", url: "" }],
      ["every payload key empty", { type: "audio", data: "", base64: "", url: "" }],
      ["no payload key at all", { type: "image" }],
    ])("drops and logs a media block with %s", (_name, block) => {
      const { content, warnings } = inbound([block]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("no data, base64 or url to carry back"),
      ]);
    });

    // ── the same three rules on the outbound leg ───────────────────────────
    it.each([
      ["a type added to the AG-UI union later", { type: "totally_unknown" }],
      ["no type key at all", { foo: "bar" }],
    ])("logs a drop for an outbound content item with %s", (_name, item) => {
      const { content, warnings } = outbound([item]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("Dropping unsupported content item of type"),
      ]);
    });

    it.each([
      ["a number", 42, "number"],
      ["an object", { a: 1 }, "object"],
      ["a null", null, "null"],
    ])("drops and logs an outbound text item whose text is %s", (_name, text, described) => {
      // Python reaches its outbound converter with a pydantic-validated
      // `TextInputContent`, so its `text` is a `str` by construction; nothing
      // validates the equivalent here, and a non-string forwarded into a provider
      // content block is a 400 from the provider rather than a dropped word.
      const { content, warnings } = outbound([{ type: "text", text }]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining(`Dropping text content: text is ${described}, not a string`),
      ]);
    });

    it("keeps the items on either side of an outbound item it cannot convert", () => {
      const { content, warnings } = outbound([
        { type: "text", text: "before" },
        { type: "totally_unknown" },
        { type: "text", text: "after" },
      ]);

      expect(content).toEqual([
        { type: "text", text: "before" },
        { type: "text", text: "after" },
      ]);
      expect(warnings).toHaveLength(1);
    });

    it("keeps the items on either side of an outbound text item it cannot read", () => {
      const { content, warnings } = outbound([
        { type: "text", text: "before" },
        { type: "text", text: 42 },
        { type: "text", text: "after" },
      ]);

      expect(content).toEqual([
        { type: "text", text: "before" },
        { type: "text", text: "after" },
      ]);
      expect(warnings).toHaveLength(1);
    });

    it("converts a well-formed outbound array with nothing logged", () => {
      // The other side of every guard above: what IS usable must still convert,
      // and must do it SILENTLY. A guard that logs on good input is a guard that
      // trains an operator to ignore the log.
      const { content, warnings } = outbound([
        { type: "text", text: "hello" },
        { type: "image", source: { type: "url", value: "https://example.com/a.png" } },
      ]);

      expect(content).toEqual([
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ]);
      expect(warnings).toEqual([]);
    });

    it("drops and logs a media item whose url source is the empty string", () => {
      // `mediaSourceToUrl` returns the url VERBATIM, so an empty one comes back
      // as `""`. Emitting it would put an `image_url` block pointing at nothing
      // on the provider request; the caller's truthiness check is what stops it,
      // and Python's `if url:` is the line that must agree.
      const { content, warnings } = outbound([
        { type: "image", source: { type: "url", value: "" } },
      ]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("Dropping image content: source could not be converted to URL"),
      ]);
    });

    // ── the modality carried inside an image_url data URL ──────────────────
    //
    // `image_url` is the fallback block for every modality the outbound leg
    // cannot send as a standard block, so the MIME type inside its data URL is
    // the only remaining modality signal on the way back. Reading it wrong
    // retypes the attachment in MESSAGES_SNAPSHOT permanently.
    it.each([
      ["an uppercase major type", "VIDEO/MP4", "video", "VIDEO/MP4"],
      ["a mixed-case major type", "Audio/WAV", "audio", "Audio/WAV"],
      ["a padded major type", " video/mp4", "video", " video/mp4"],
      // The data URL's own `;` separator takes the parameters off before the
      // MIME type is ever read, so the recorded type is the bare one.
      ["a major type with parameters", "video/mp4;codecs=avc1", "video", "video/mp4"],
      ["an unknown major type", "application/pdf", "document", "application/pdf"],
      // The malformed-MIME guard. Without it these read as documents, because
      // the major-type lookup misses and the fallback is `document` — so a
      // MIME-less image would come back as a file. "Not major/subtype" carries
      // no modality at all, and the historical answer for that is `image`.
      ["no slash at all", "noslash", "image", "noslash"],
      ["an empty subtype", "video/", "image", "video/"],
      ["an empty major type", "/mp4", "image", "/mp4"],
      ["nothing but a slash", "/", "image", "/"],
      // Everything after the FIRST slash is the subtype, so `a/b/c` IS
      // major/subtype and takes the lookup, unlike the four above.
      ["a third segment", "a/b/c", "document", "a/b/c"],
    ])(
      "recovers the modality of an image_url data URL with %s",
      (_name, mime, type, recorded) => {
        const { content } = inbound([
          { type: "image_url", image_url: { url: `data:${mime};base64,QUJD` } },
        ]);

        expect(content).toEqual([
          { type, source: { type: "data", value: "QUJD", mimeType: recorded } },
        ]);
      },
    );

    // ── one metadata key, outbound ─────────────────────────────────────────
    it("reads only metadata.filename outbound, and derives a name when it is absent", () => {
      // The INBOUND reader scans `filename` then `name` then `title`, because
      // those are the spellings langchain-core's translators read. The OUTBOUND
      // writer must NOT: `metadata.filename` is the one documented field of the
      // block, and widening the read here would put a name on the wire that the
      // AG-UI item never claimed was a filename. Python's
      // `_filename_from_metadata` reads the same single key.
      const { content } = outbound([
        {
          type: "document",
          source: { type: "data", value: "aGk=", mimeType: "application/pdf" },
          metadata: { name: "from-name.pdf", title: "from-title.pdf" },
        },
      ]);

      expect(content).toEqual([
        {
          type: "file",
          source_type: "base64",
          data: "aGk=",
          mime_type: "application/pdf",
          metadata: { filename: "attachment.pdf" },
        },
      ]);
    });

    // ── rule 1 on the TYPED media path ─────────────────────────────────────
    //
    // The guard for a non-string MIME type was written on the legacy `binary`
    // branch and not on its typed sibling, so `mimeType: 42` on a typed AUDIO
    // item reached `normalizedAudioMimeType`'s `.split` and threw a TypeError
    // out of the whole message-list conversion — the same defect the legacy
    // branch already had a comment explaining. Measured before the fix:
    // typed audio + a numeric or object MIME threw; legacy binary and typed
    // document with the same MIME did not.
    it.each([
      ["a number", 42],
      ["an object", {}],
      ["an array", []],
      ["true", true],
      ["null", null],
    ])("does not throw when a typed audio item's mimeType is %s", (_name, mimeType) => {
      const { content, warnings } = outbound([
        { type: "audio", source: { type: "data", value: "QUJD", mimeType } },
      ]);

      // An unusable MIME type is an absent one: no audio format is named, so
      // the item keeps the `image_url` fallback with an omitted mediatype —
      // byte for byte what the legacy branch already produced, and what
      // Python's `_normalized_audio_mime_type` now produces too.
      expect(content).toEqual([{ type: "image_url", image_url: { url: "data:;base64,QUJD" } }]);
      expect(warnings).toEqual([]);
    });

    it("does not throw when a typed document item's mimeType is not a string", () => {
      // The document path reached `deriveFilename` with the same value. It
      // survived here because `standardBlockTypeFor` substitutes for it first,
      // but Python's did not, and the two derivations must not disagree about
      // what a non-string MIME type is.
      const { content, warnings } = outbound([
        { type: "document", source: { type: "data", value: "QUJD", mimeType: 42 } },
      ]);

      expect(content).toEqual([
        {
          type: "file",
          source_type: "base64",
          data: "QUJD",
          mime_type: "application/octet-stream",
          metadata: { filename: "attachment.bin" },
        },
      ]);
      expect(warnings).toEqual([]);
    });

    it("keeps the items on either side of a typed audio item with a non-string mimeType", () => {
      // Rule 3. The throw cost both neighbours, not just the attachment.
      const { content } = outbound([
        { type: "text", text: "before" },
        { type: "audio", source: { type: "data", value: "QUJD", mimeType: 42 } },
        { type: "text", text: "after" },
      ]);

      expect(content.map((c: any) => c.type)).toEqual(["text", "image_url", "text"]);
      expect(textsOf(content.filter((c: any) => c.type === "text"))).toEqual(["before", "after"]);
    });

    // ── rule 1 + 2: a data URL with no payload ─────────────────────────────
    it.each([
      ["no comma at all", "data:image/png;base64"],
      ["nothing after the comma", "data:image/png;base64,"],
      ["no mediatype and no payload", "data:;base64,"],
      ["nothing but the scheme", "data:"],
      ["a mediatype and nothing else", "data:image/png"],
    ])("drops and logs an image_url data URL with %s", (_name, url) => {
      // Kept before this change as an attachment whose `value` is the EMPTY
      // STRING — an item pointing at nothing, written into the thread and read
      // back on every later open. The standard-block path already dropped an
      // empty `data`/`base64`; this branch was the one place that did not.
      const { content, warnings } = inbound([{ type: "image_url", image_url: { url } }]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        expect.stringContaining("Dropping image_url block: data URL carries no payload"),
      ]);
    });

    it("keeps the blocks on either side of a payload-less data URL", () => {
      const { content, warnings } = inbound([
        { type: "text", text: "before" },
        { type: "image_url", image_url: { url: "data:image/png;base64" } },
        { type: "text", text: "after" },
      ]);

      expect(textsOf(content)).toEqual(["before", "after"]);
      expect(warnings).toHaveLength(1);
    });

    it("keeps the whole payload of a data URL carrying more than one comma", () => {
      // The payload is everything after the FIRST comma (RFC 2397 §3).
      // `split(",", 2)` kept only the segment between the first and second and
      // silently truncated the rest, where Python's `split(",", 1)` kept it all.
      const { content } = inbound([
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD,EXTRA" } },
      ]);

      expect(content).toEqual([
        { type: "image", source: { type: "data", value: "QUJD,EXTRA", mimeType: "image/png" } },
      ]);
    });

    // ── rules 1+2 on the OUTBOUND payload ─────────────────────────────────
    //
    // The contract landed on the inbound leg first and the outbound source
    // payload was still read without checking it, which broke rule 2 in the
    // direction that reaches the provider: an item whose `value` was `null`, a
    // number or the empty string was neither dropped nor logged — it was EMITTED,
    // as `data: null` on a standard media block, as `data:image/png;base64,42`
    // inside an `image_url`, or as a bare `image_url: { url: 42 }`. The model
    // then answers about an attachment it never received, and there is no line in
    // the log to explain it. Every emission point on this leg is covered below:
    // the standard media block, the data-URL construction, and the legacy binary
    // path.
    const UNUSABLE_PAYLOADS: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["the empty string", ""],
      ["a number", 42],
      ["a boolean", true],
      ["an object", {}],
      ["an array", []],
    ];

    describe.each([
      ["document", "application/pdf", "the file standard block"],
      ["audio", "audio/wav", "the audio standard block"],
      ["image", "image/png", "the image_url data URL"],
      ["video", "video/mp4", "the image_url data URL"],
    ])("a %s data source with an unusable payload (%s)", (type, mimeType, _emissionPoint) => {
      it.each(UNUSABLE_PAYLOADS)("is dropped and logged once when it is %s", (_name, value) => {
        const { content, warnings } = outbound([
          { type, source: { type: "data", value, mimeType } },
        ]);

        expect(content).toEqual([]);
        expect(warnings).toEqual([
          `[convertAguiMultimodalToLangchain] Dropping ${type} content: source could not be converted to URL`,
        ]);
      });
    });

    it.each([
      ["a number", 42],
      ["an object", {}],
      ["an array", []],
      ["a boolean", true],
      ["null", null],
      ["the empty string", ""],
    ])("drops a url source whose value is %s, with one log", (_name, value) => {
      // `{}` is the one that DIVERGED rather than merely leaking: truthy here and
      // falsy in Python, so the same item was kept by this runtime and dropped by
      // the other. Both drop it now.
      const { content, warnings } = outbound([{ type: "image", source: { type: "url", value } }]);

      expect(content).toEqual([]);
      expect(warnings).toEqual([
        "[convertAguiMultimodalToLangchain] Dropping image content: source could not be converted to URL",
      ]);
    });

    it.each([
      ["data", "application/pdf", { data: 42 }],
      ["data", "audio/wav", { data: null }],
      ["data", "image/png", { data: {} }],
      ["url", "image/png", { url: 42 }],
      ["url", "application/pdf", { url: [] }],
      ["id", "image/png", { id: 42 }],
      ["id", "image/png", { id: true }],
    ])(
      "drops a legacy binary item whose %s payload is unusable (%s)",
      (_key, mimeType, payload) => {
        const { content, warnings } = outbound([{ type: "binary", mimeType, ...payload }]);

        expect(content).toEqual([]);
        expect(warnings).toEqual([
          "[convertAguiMultimodalToLangchain] Dropping BinaryInputContent: no url, data, or id provided",
        ]);
      },
    );

    it("does not let an unusable legacy url shadow a usable data payload", () => {
      // An unusable payload is an ABSENT payload — the rule this file already
      // applies to a MIME type and to a filename. `url` outranks `data` only when
      // there is a url; a `url` of 42 is not one, so the bytes that ARE there go
      // out instead of the item being lost with them.
      const { content, warnings } = outbound([
        { type: "binary", mimeType: "image/png", url: 42, data: "QUJD" },
      ]);

      expect(content).toEqual([
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ]);
      expect(warnings).toEqual([]);
    });

    it("keeps the items around an unusable outbound payload, and the messages", () => {
      // Rule 3, and the reason rule 1 is written the way it is. This converter
      // builds a whole provider request: the cost of getting one attachment wrong
      // must be that one attachment. Asserted, not assumed — the text on either
      // side, the GOOD attachment beside it, and the messages before and after.
      const warnings: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(String(args[0]));
      });
      let messages;
      try {
        messages = aguiMessagesToLangChain([
          { id: "m1", role: "user", content: "before message" } as UserMessage,
          {
            id: "m2",
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "document", source: { type: "data", value: null, mimeType: "application/pdf" } },
              {
                type: "document",
                source: { type: "data", value: "aGk=", mimeType: "application/pdf" },
              },
              { type: "text", text: "after" },
            ],
          } as unknown as UserMessage,
          { id: "m3", role: "user", content: "after message" } as UserMessage,
        ]);
      } finally {
        warn.mockRestore();
      }

      expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(messages[0].content).toBe("before message");
      expect(messages[2].content).toBe("after message");
      expect(messages[1].content).toEqual([
        { type: "text", text: "before" },
        {
          type: "file",
          source_type: "base64",
          data: "aGk=",
          mime_type: "application/pdf",
          metadata: { filename: "attachment.pdf" },
        },
        { type: "text", text: "after" },
      ]);
      expect(warnings).toEqual([
        "[convertAguiMultimodalToLangchain] Dropping document content: source could not be converted to URL",
      ]);
    });

    it("accepts what the data-URL rule produces rather than undoing it", () => {
      // The sibling fix normalizes a `data:` URL into inline data BEFORE the
      // block is chosen. The payload check must read the bytes that come out of
      // that parse, not the url string it came from — checking the wrong one
      // would push every data-URL-sourced attachment back onto `image_url`, which
      // is the defect that fix exists to remove.
      const { content, warnings } = outbound([
        { type: "document", source: { type: "url", value: "data:application/pdf;base64,JVBERi0=" } },
        { type: "audio", source: { type: "url", value: "data:audio/wav;base64,QUJD" } },
        { type: "binary", mimeType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" },
      ]);

      expect(content).toEqual([
        {
          type: "file",
          source_type: "base64",
          data: "JVBERi0=",
          mime_type: "application/pdf",
          metadata: { filename: "attachment.pdf" },
        },
        { type: "audio", source_type: "base64", data: "QUJD", mime_type: "audio/wav" },
        {
          type: "file",
          source_type: "base64",
          data: "JVBERi0=",
          mime_type: "application/pdf",
          metadata: { filename: "attachment.pdf" },
        },
      ]);
      expect(warnings).toEqual([]);
    });

    // ── the KNOWN LIMIT on {@link OPENAI_AUDIO_MIME_TYPES} ─────────────────
    it("re-emits an adapter-normalized audio MIME type unchanged on the next send", () => {
      // The normalization is visible in the thread: a client that sent
      // `audio/mpeg` reads `audio/mp3` back. Left that way deliberately — see
      // the KNOWN LIMIT on `OPENAI_AUDIO_MIME_TYPES` for why the
      // `suppliedFilename` treatment does not transfer. What makes it
      // acceptable is that it does not DRIFT: the value the return leg records
      // re-normalizes to itself, so every later send carries the identical MIME
      // type and the modality survives. This test is that property.
      const first = outbound([
        { type: "audio", source: { type: "data", value: "QUJD", mimeType: "audio/mpeg" } },
      ]);
      expect(first.content).toEqual([
        { type: "audio", source_type: "base64", data: "QUJD", mime_type: "audio/mp3" },
      ]);

      const readBack = inbound(first.content);
      expect(readBack.content).toEqual([
        { type: "audio", source: { type: "data", value: "QUJD", mimeType: "audio/mp3" } },
      ]);

      const second = outbound(readBack.content);
      expect(second.content).toEqual(first.content);
    });
  });

  // ── Provider boundary ────────────────────────────────────────────────────
  //
  // The tests above assert the SHAPE this adapter emits. On their own that is
  // exactly the trap that let the wrong shape ship: a converter and its tests
  // agreeing on an invented schema look identical to a correct one. These tests
  // hand the emitted blocks to the real `@langchain/openai` translator and read
  // what lands on the wire, with a stub `fetch` so nothing leaves the process.
  describe("provider boundary (@langchain/openai)", () => {
    /** Convert through ChatOpenAI and return the outgoing content parts. */
    async function partsOnTheWire(blocks: unknown[]): Promise<any[]> {
      let body: any;
      const model = new ChatOpenAI({
        apiKey: "test-not-used",
        model: "gpt-4o-mini",
        configuration: {
          fetch: async (_url: any, init: any) => {
            body = JSON.parse(init.body);
            return new Response(
              JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                created: 0,
                model: "gpt-4o-mini",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "ok" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      });

      // NO `response_metadata` marker. Setting `output_version: "v1"` here would
      // select a conversion path the adapter's real output never reaches — and
      // that is exactly how the previous round's shape passed its own tests
      // while being forwarded to the provider raw.
      await model.invoke([
        new HumanMessage({ content: [{ type: "text", text: "hi" }, ...blocks] as any }),
      ]);

      return body.messages[0].content;
    }

    /**
     * The LangChain blocks this adapter emits for one AG-UI message.
     *
     * There is deliberately no `.filter((b) => b.type !== "text")` here, and
     * there never should have been one: every AG-UI message in this block
     * carries its attachment and nothing else, so that filter removed nothing
     * while reading as though it removed something. The text part these tests
     * index past is the one `partsOnTheWire` adds on the way to the provider.
     */
    function emittedBlocks(message: unknown): any[] {
      return aguiMessagesToLangChain([message as UserMessage])[0].content as any[];
    }

    it("carries an emitted PDF block to OpenAI as a file part", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-pdf",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
            metadata: { filename: "invoice-q2.pdf" },
          } as DocumentInputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts).toEqual([
        { type: "text", text: "hi" },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            // The real filename, NOT the `LC_AUTOGENERATED` placeholder the
            // translator substitutes when it cannot find one.
            filename: "invoice-q2.pdf",
          },
        },
      ]);
    });

    it("carries an emitted audio block to OpenAI as an input_audio part", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-audio",
        role: "user",
        content: [
          {
            type: "audio",
            source: { type: "data", value: "SGVsbG8=", mimeType: "audio/wav" },
          } as AudioInputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "input_audio",
        input_audio: { data: "SGVsbG8=", format: "wav" },
      });
    });

    it("carries an emitted filename-less PDF to OpenAI with the derived name", async () => {
      // The document path claims to work. It only does because the converter
      // substitutes a filename: without one this exact call throws inside
      // `@langchain/openai` before a request is ever built.
      const aguiMessage: UserMessage = {
        id: "boundary-pdf-no-filename",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
          } as DocumentInputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "file",
        file: {
          file_data: "data:application/pdf;base64,JVBERi0xLjQK",
          filename: "attachment.pdf",
        },
      });
    });

    // The five filename situations an attachment can be in, each one carried all
    // the way to the wire: supplied; supplied-but-empty on a typed item;
    // supplied-but-empty on a legacy binary item; absent with a MIME type
    // `FILENAME_EXTENSIONS` knows; absent with one it does not.
    // This is the evidence that the value is load-bearing:
    // the translator THROWS on a file part it cannot find a name for, so a row
    // that reaches `parts` at all is a row that does not kill the run. Mirrored
    // in Python by `test_every_filename_situation_reaches_the_provider`.
    it.each([
      [
        "supplied",
        { type: "document", source: { type: "data", value: "aGk=", mimeType: "application/pdf" }, metadata: { filename: "real.pdf" } },
        "real.pdf",
      ],
      [
        // The empty string used to survive the `??` chain, produce a block with
        // NO filename, and throw right here.
        "empty-string supplied, typed",
        { type: "document", source: { type: "data", value: "aGk=", mimeType: "application/pdf" }, metadata: { filename: "" } },
        "attachment.pdf",
      ],
      [
        "empty-string supplied, legacy binary",
        { type: "binary", mimeType: "application/pdf", data: "aGk=", filename: "" },
        "attachment.pdf",
      ],
      [
        "absent with a known MIME type",
        { type: "document", source: { type: "data", value: "aGk=", mimeType: "text/plain" } },
        "attachment.txt",
      ],
      [
        "absent with an unknown MIME type",
        { type: "document", source: { type: "data", value: "aGk=", mimeType: "application/x-weird-thing" } },
        "attachment.bin",
      ],
    ])("reaches OpenAI with a usable filename when it is %s", async (_name, item, filename) => {
      const emitted = emittedBlocks(
          { id: "filename-situation", role: "user", content: [item] } as unknown as UserMessage,
      );

      const parts = await partsOnTheWire(emitted);

      expect(parts[1].type).toBe("file");
      expect(parts[1].file.filename).toBe(filename);
    });

    it("carries an emitted legacy-binary PDF to OpenAI as a file part", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-legacy-pdf",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "application/pdf",
            data: "JVBERi0xLjQK",
            filename: "legacy-invoice.pdf",
          } as LegacyBinaryInputContent as unknown as InputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "file",
        file: {
          file_data: "data:application/pdf;base64,JVBERi0xLjQK",
          filename: "legacy-invoice.pdf",
        },
      });
    });

    it("carries an emitted legacy-binary audio clip to OpenAI as an input_audio part", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-legacy-audio",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "audio/wav",
            data: "SGVsbG8=",
          } as LegacyBinaryInputContent as unknown as InputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "input_audio",
        input_audio: { data: "SGVsbG8=", format: "wav" },
      });
    });

    // ── Audio MIME types ────────────────────────────────────────────────
    //
    // `input_audio.format` is an enum of exactly two values, and both runtimes
    // derive it from the block's `mime_type`. So "audio, data converts" was never
    // true as stated — it was true of the `audio/wav` it was measured on. These
    // cases pin the real constraint at the provider boundary, per spelling.

    // Everything the converter ADMITS, with the exact part that lands on the
    // wire. `audio/mpeg` is the load-bearing row: it is the IANA type for MP3 and
    // what a browser reports for a `.mp3`, and it is NOT what the provider's enum
    // lists — so it only works because the converter rewrites the spelling.
    it.each([
      ["audio/wav", "wav"],
      ["audio/mp3", "mp3"],
      ["audio/mpeg", "mp3"],
      ["audio/x-wav", "wav"],
      ["audio/wave", "wav"],
      ["audio/vnd.wave", "wav"],
      // MIME types are case-insensitive (RFC 2045 §5.1) and may carry parameters;
      // neither makes a supported format unsupported.
      ["AUDIO/MPEG", "mp3"],
      ["audio/WAV", "wav"],
      ["audio/mpeg; charset=binary", "mp3"],
      ["audio/wav; codecs=1", "wav"],
    ])("carries %s to OpenAI as input_audio format %s", async (mimeType, format) => {
      const aguiMessage: UserMessage = {
        id: "boundary-audio-mime",
        role: "user",
        content: [
          {
            type: "audio",
            source: { type: "data", value: "SGVsbG8=", mimeType },
          } as AudioInputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "input_audio",
        input_audio: { data: "SGVsbG8=", format },
      });
    });

    // The legacy `binary` path routes through the SAME gate, so it admits and
    // normalizes identically. A divergence between the two paths would put the
    // same clip on the wire two different ways depending on which client sent it.
    it.each([
      ["audio/mpeg", "mp3"],
      ["audio/x-wav", "wav"],
      ["AUDIO/MPEG", "mp3"],
    ])("carries legacy-binary %s to OpenAI as input_audio format %s", async (mimeType, format) => {
      const aguiMessage: UserMessage = {
        id: "boundary-legacy-audio-mime",
        role: "user",
        content: [{ type: "binary", mimeType, data: "SGVsbG8=" } as LegacyBinaryInputContent as unknown as InputContent],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "input_audio",
        input_audio: { data: "SGVsbG8=", format },
      });
    });

    // Why the rewrite is not cosmetic: hand the provider the type the client
    // ACTUALLY sent for an MP3 and the run dies inside the translator, before a
    // request is built. This is the throw the normalization step exists to avoid,
    // pinned so it cannot be quietly reintroduced by widening the gate instead.
    it("would throw at the provider for a raw audio/mpeg block — hence the rewrite", async () => {
      const raw = {
        type: "audio",
        source_type: "base64",
        data: "SGVsbG8=",
        mime_type: "audio/mpeg",
      };

      await expect(partsOnTheWire([raw])).rejects.toThrow(
        /must have mime type of audio\/wav or audio\/mp3/,
      );

      // And the converter does not emit that block. Asserting only the throw
      // documents `@langchain/openai` and pins nothing here — the assertion
      // holds with this module deleted. The row is a claim about a CHOICE this
      // adapter makes, so the choice is what it has to read.
      expect(
        emittedBlocks({
          id: "raw-mpeg",
          role: "user",
          content: [
            { type: "audio", source: { type: "data", value: "SGVsbG8=", mimeType: "audio/mpeg" } },
          ],
        }),
      ).toEqual([{ ...raw, mime_type: "audio/mp3" }]);
    });

    // Everything the converter REFUSES. Two claims per row, and both matter: the
    // block stays on the pre-existing `image_url` path (so this change regresses
    // nothing), and that path reaches the wire WITHOUT throwing — degraded but
    // alive, which is the whole premise of the narrow gate.
    it.each(["audio/ogg", "audio/aac", "audio/webm", "audio/flac", "audio/mp4"])(
      "keeps %s on the image_url path, which does not throw",
      async (mimeType) => {
        const aguiMessage: UserMessage = {
          id: "boundary-audio-unsupported",
          role: "user",
          content: [
            {
              type: "audio",
              source: { type: "data", value: "SGVsbG8=", mimeType },
            } as AudioInputContent,
          ],
        };

        const emitted = emittedBlocks(aguiMessage);
        expect(emitted).toEqual([
          { type: "image_url", image_url: { url: `data:${mimeType};base64,SGVsbG8=` } },
        ]);

        const parts = await partsOnTheWire(emitted);
        expect(parts[1]).toEqual({
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,SGVsbG8=` },
        });
      },
    );

    it.each(["audio/ogg", "audio/webm"])(
      "keeps legacy-binary %s on the image_url path",
      async (mimeType) => {
        const aguiMessage: UserMessage = {
          id: "boundary-legacy-audio-unsupported",
          role: "user",
          content: [{ type: "binary", mimeType, data: "SGVsbG8=" } as LegacyBinaryInputContent as unknown as InputContent],
        };

        const emitted = emittedBlocks(aguiMessage);
        expect(emitted).toEqual([
          { type: "image_url", image_url: { url: `data:${mimeType};base64,SGVsbG8=` } },
        ]);
      },
    );

    // The normalization is audio-only. Documents carry their MIME type inside a
    // `file_data` data URL where no enum constrains it, so rewriting one there
    // would corrupt a working path.
    it("does not rewrite a document MIME type", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-doc-mime-untouched",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/vnd.ms-excel" },
          } as DocumentInputContent,
        ],
      };

      const emitted = emittedBlocks(aguiMessage);
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "file",
        file: {
          file_data: "data:application/vnd.ms-excel;base64,JVBERi0xLjQK",
          // The MIME TYPE is untouched — `application/vnd.ms-excel`, verbatim,
          // inside the data URL. The FILENAME is a separate decision: `.xls` is
          // this type's extension, and `attachment.vnd.ms-excel` named a file
          // `attachment` with an extension `.vnd`.
          filename: "attachment.xls",
        },
      });
    });

    // The other half of the decision: the combinations this converter REFUSES to
    // announce as standard blocks, and the throw that is the reason why. If one
    // of these ever stops throwing, the corresponding row in
    // `standardBlockTypeFor` can be revisited — but not before.
    //
    // Each row carries BOTH halves, and it has to. A row that only asserted the
    // throw would document `@langchain/openai` and pin nothing here: it passes
    // with this module gutted, while its own name makes a claim about what the
    // adapter does instead. So every row also drives the equivalent AG-UI item
    // through the converter and reads the block it actually emits.
    it.each([
      [
        "audio by url",
        { type: "audio", source: { type: "url", value: "https://example.com/a.wav", mimeType: "audio/wav" } },
        { type: "audio", source_type: "url", url: "https://example.com/a.wav", mime_type: "audio/wav" },
        { type: "image_url", image_url: { url: "https://example.com/a.wav" } },
        /must be formatted as a data URL/,
      ],
      [
        "video by base64",
        { type: "video", source: { type: "data", value: "AAA=", mimeType: "video/mp4" } },
        { type: "video", source_type: "base64", data: "AAA=", mime_type: "video/mp4" },
        { type: "image_url", image_url: { url: "data:video/mp4;base64,AAA=" } },
        /'video'.*not recognized/,
      ],
      [
        "video by url",
        { type: "video", source: { type: "url", value: "https://example.com/v.mp4", mimeType: "video/mp4" } },
        { type: "video", source_type: "url", url: "https://example.com/v.mp4", mime_type: "video/mp4" },
        { type: "image_url", image_url: { url: "https://example.com/v.mp4" } },
        /'video'.*not recognized/,
      ],
      [
        "file by url",
        {
          type: "document",
          source: { type: "url", value: "https://example.com/d.pdf", mimeType: "application/pdf" },
          metadata: { filename: "d.pdf" },
        },
        {
          type: "file",
          source_type: "url",
          url: "https://example.com/d.pdf",
          mime_type: "application/pdf",
          metadata: { filename: "d.pdf" },
        },
        { type: "image_url", image_url: { url: "https://example.com/d.pdf" } },
        /must be formatted as a data URL/,
      ],
    ])(
      "would throw at the provider for %s — hence the image_url fallback",
      async (_name, aguiItem, refusedBlock, fallback, message) => {
        await expect(partsOnTheWire([refusedBlock])).rejects.toThrow(message);

        expect(
          emittedBlocks({ id: "refused", role: "user", content: [aguiItem] }),
        ).toEqual([fallback]);
      },
    );

    // Not an `image_url` fallback, which is why this row is not in the table
    // above: the converter DOES emit a file block for a filename-less document.
    // What it does not do is emit it nameless, and this is the throw that is the
    // reason why.
    it("would throw at the provider for a nameless file block — hence the derived name", async () => {
      const nameless = {
        type: "file",
        source_type: "base64",
        data: "JVBERi0xLjQK",
        mime_type: "application/pdf",
      };

      await expect(partsOnTheWire([nameless])).rejects.toThrow(
        /a filename or name or title is needed/,
      );

      expect(
        emittedBlocks({
          id: "nameless-file",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
            },
          ],
        }),
      ).toEqual([{ ...nameless, metadata: { filename: "attachment.pdf" } }]);
    });

    it("forwards a block with no source_type RAW — the regression this guards", async () => {
      // The failure mode, pinned. Without `source_type` the default path's
      // `isDataContentBlock` gate does not recognise the block as media, so it is
      // neither translated NOR rejected: it goes to the provider verbatim, and the
      // request carries a content part the API will not accept.
      //
      // This is what the previous round of this PR emitted. It passed its own
      // tests because those tests set `response_metadata.output_version = "v1"`,
      // selecting a conversion path the adapter's real output never reaches.
      const nativeJsShapeWithNoSourceType = {
        type: "file",
        data: "JVBERi0xLjQK",
        mimeType: "application/pdf",
        metadata: { filename: "invoice-q2.pdf" },
      };

      const parts = await partsOnTheWire([nativeJsShapeWithNoSourceType]);

      expect(parts[1]).toEqual(nativeJsShapeWithNoSourceType);
      expect(parts[1]).not.toHaveProperty("file");

      // Which is only a reason to guard something if this adapter is the thing
      // guarded. Without this line the test above holds with the converter
      // deleted — it would be a fact about `@langchain/openai` and nothing else.
      expect(
        emittedBlocks({
          id: "has-source-type",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
              metadata: { filename: "invoice-q2.pdf" },
            },
          ],
        })[0],
      ).toHaveProperty("source_type", "base64");
    });

    // ── A document with no usable MIME type ───────────────────────────────
    //
    // The translator does not supply a default: it interpolates whatever
    // `mime_type` it is handed straight into the data URL, so a missing one
    // reached the provider as `data:;base64,…` — an omitted mediatype, which
    // RFC 2397 §2 DEFINES as `text/plain;charset=US-ASCII`. The part did not
    // lack a type, it claimed the wrong one.
    it.each([
      ["empty-string MIME type", ""],
      ["absent MIME type", undefined],
    ])("names a document's bytes octet-stream at the provider when it has an %s", async (_name, mimeType) => {
      const emitted = emittedBlocks(
          {
            id: "boundary-no-mime",
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "data", value: "aGk=", ...(mimeType === undefined ? {} : { mimeType }) },
              },
            ],
          } as unknown as UserMessage,
      );

      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "file",
        file: {
          // NOT `data:;base64,aGk=`.
          file_data: "data:application/octet-stream;base64,aGk=",
          // The MIME type and the derived filename agree about what the file
          // is, which is the property that makes the round trip exact.
          filename: "attachment.bin",
        },
      });
    });

    // The `image_url` fallback path takes the other answer, and the difference
    // is deliberate: `application/octet-stream` reads back as a DOCUMENT
    // through `aguiMediaTypeForMimeType`, so substituting it here would retype
    // a MIME-less image. What must not survive either way is the literal text
    // `undefined`, which is what template interpolation renders an absent
    // `mimeType` as.
    it.each([
      ["typed image content", { type: "image", source: { type: "data", value: "aGk=" } }],
      ["legacy binary content", { type: "binary", data: "aGk=" }],
    ])("does not put the text `undefined` in the data URL for %s with no MIME type", async (_name, item) => {
      const emitted = emittedBlocks(
          { id: "boundary-undefined-mime", role: "user", content: [item] } as unknown as UserMessage,
      );

      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:;base64,aGk=" } });
    });

    // ── Data URLs, all the way to the wire ────────────────────────────────
    //
    // THE CLAIM THAT MATTERS for the data-URL rule, and it is only checkable
    // here. The adapter's own output for these inputs is a standard block, and
    // a standard block that the translator then rejected would be strictly
    // WORSE than the `image_url` it replaced — a dead run instead of a bad
    // request. So these run the whole leg: an inbound block carrying a `data:`
    // URL, through the AG-UI item it becomes, back out through the converter,
    // and into `@langchain/openai` with a stubbed `fetch`.
    //
    // Before the data-URL rule both of these reached the provider as
    // `image_url` — a PDF and a WAV labelled as images, which is the failure
    // this whole PR exists to fix, recreated by a url-SHAPED source that
    // carried its bytes inline all along.
    //
    // Mirrored in Python by `test_a_data_url_backed_pdf_reaches_the_provider_as_a_file_part`
    // and `test_a_data_url_backed_wav_reaches_the_provider_as_input_audio`.
    it("carries a data-URL-backed PDF round trip to OpenAI as a file part", async () => {
      const agui = (
        langchainMessagesToAgui([
          {
            id: "boundary-data-url-pdf",
            type: "human",
            content: [
              {
                type: "file",
                url: "data:application/pdf;base64,JVBERi0xLjQK",
                mime_type: "application/pdf",
                metadata: { filename: "in.pdf" },
              },
            ],
          } as unknown as LangGraphMessage,
        ])[0] as UserMessage
      ).content;

      // The AG-UI item the thread now holds says the bytes are INLINE, which is
      // where they really are. Pinned here as well as in the parity table
      // because it is the input to the leg below.
      expect(agui).toEqual([
        {
          type: "document",
          source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
          metadata: { filename: "in.pdf" },
        },
      ]);

      const parts = await partsOnTheWire(
        emittedBlocks({ id: "boundary-data-url-pdf", role: "user", content: agui }),
      );

      expect(parts[1]).toEqual({
        type: "file",
        file: { file_data: "data:application/pdf;base64,JVBERi0xLjQK", filename: "in.pdf" },
      });
    });

    it("carries a data-URL-backed WAV round trip to OpenAI as an input_audio part", async () => {
      const agui = (
        langchainMessagesToAgui([
          {
            id: "boundary-data-url-wav",
            type: "human",
            content: [{ type: "audio", url: "data:audio/wav;base64,SGVsbG8=", mime_type: "audio/wav" }],
          } as unknown as LangGraphMessage,
        ])[0] as UserMessage
      ).content;

      expect(agui).toEqual([
        { type: "audio", source: { type: "data", value: "SGVsbG8=", mimeType: "audio/wav" } },
      ]);

      const parts = await partsOnTheWire(
        emittedBlocks({ id: "boundary-data-url-wav", role: "user", content: agui }),
      );

      expect(parts[1]).toEqual({
        type: "input_audio",
        input_audio: { data: "SGVsbG8=", format: "wav" },
      });
    });

    // The outbound half on its own, for a url source that did NOT come from
    // this adapter's inbound leg: a thread persisted before the data-URL rule
    // existed still holds one, and so does client JSON that built it directly.
    it.each([
      [
        "PDF",
        { type: "document", source: { type: "url", value: "data:application/pdf;base64,JVBERi0xLjQK" }, metadata: { filename: "in.pdf" } },
        { type: "file", file: { file_data: "data:application/pdf;base64,JVBERi0xLjQK", filename: "in.pdf" } },
      ],
      [
        "WAV",
        { type: "audio", source: { type: "url", value: "data:audio/wav;base64,SGVsbG8=" } },
        { type: "input_audio", input_audio: { data: "SGVsbG8=", format: "wav" } },
      ],
      [
        "legacy binary PDF",
        { type: "binary", url: "data:application/pdf;base64,JVBERi0xLjQK", mimeType: "application/pdf", filename: "in.pdf" },
        { type: "file", file: { file_data: "data:application/pdf;base64,JVBERi0xLjQK", filename: "in.pdf" } },
      ],
    ])("carries a stored url source holding a data URL to OpenAI: %s", async (_name, item, expected) => {
      const parts = await partsOnTheWire(
        emittedBlocks({
          id: "boundary-stored-data-url",
          role: "user",
          content: [item],
        } as unknown as UserMessage),
      );

      expect(parts[1]).toEqual(expected);
    });

    // The other side of the rule, and the reason it is narrow. A REMOTE url
    // must still reach the provider as `image_url`: the standard block for one
    // is what `@langchain/openai` throws on, so widening the rule to cover it
    // would turn a degraded request into a dead run. `resolves` rather than a
    // shape-only assertion because a throw here is the regression.
    it.each([
      ["document", { type: "document", source: { type: "url", value: "https://example.com/a.pdf" } }, "https://example.com/a.pdf"],
      ["audio", { type: "audio", source: { type: "url", value: "https://example.com/a.wav" } }, "https://example.com/a.wav"],
      // Not base64, so not readable as inline bytes — see `parseBase64DataUrl`.
      ["non-base64 data URL", { type: "document", source: { type: "url", value: "data:text/plain,hello" } }, "data:text/plain,hello"],
      ["payload-less data URL", { type: "document", source: { type: "url", value: "data:application/pdf;base64," } }, "data:application/pdf;base64,"],
    ])("leaves a url the data-URL rule does not claim on image_url: %s", async (_name, item, url) => {
      const parts = await partsOnTheWire(
        emittedBlocks({
          id: "boundary-untouched-url",
          role: "user",
          content: [item],
        } as unknown as UserMessage),
      );

      expect(parts[1]).toEqual({ type: "image_url", image_url: { url } });
    });
  });

  // ── An empty MIME type is an absent MIME type ────────────────────────────
  //
  // Same defect as the filename above it, on the line below it: `??` falls
  // through on null/undefined only, so a present-but-empty key shadows the
  // populated one behind it. Every key here arrives off the wire, and a
  // LangGraph server that is the Python one sends the `mime_type` / `base64`
  // spellings, so a block carrying both shapes is not hypothetical.
  describe("an empty inbound value does not shadow the populated one behind it", () => {
    function firstContentBlock(block: unknown) {
      const agui = langchainMessagesToAgui([
        { id: "shadowing", type: "human", content: [block] } as unknown as LangGraphMessage,
      ]);
      return ((agui[0] as UserMessage).content as Array<any>)[0];
    }

    it("keeps mime_type when mimeType is the empty string", () => {
      expect(
        firstContentBlock({
          type: "file",
          mimeType: "",
          mime_type: "application/pdf",
          base64: "JVBERi0xLjQK",
        }),
      ).toEqual({
        type: "document",
        // NOT `application/octet-stream`, which is what the `??` chain produced
        // by discarding the real type and then falling into the data path's
        // unknown-bytes fallback.
        source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
      });
    });

    it("keeps base64 when data is the empty string", () => {
      // `??` stopped at the empty `data`, fell past BOTH return branches and
      // dropped the whole block — the attachment vanished from the snapshot.
      expect(
        firstContentBlock({
          type: "file",
          data: "",
          base64: "JVBERi0xLjQK",
          mime_type: "application/pdf",
        }),
      ).toEqual({
        type: "document",
        source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
      });
    });

    it("reads a MIME-less data URL as the image/png its own fallback names", () => {
      // A `data:` URL always has a colon, so the `includes(":")` gate never
      // fell through for one — it extracted the empty string and recorded THAT
      // as the attachment's MIME type, while the comment on
      // `aguiMediaTypeForMimeType` claimed the `image/png` default applied here.
      expect(firstContentBlock({ type: "image_url", image_url: { url: "data:;base64,aGk=" } })).toEqual({
        type: "image",
        source: { type: "data", value: "aGk=", mimeType: "image/png" },
      });
    });

    it("treats a non-string legacy mimeType as absent instead of throwing", () => {
      // `item.mimeType ?? ""` accepted a non-string and `.split(";")` on it
      // threw out of the loop that converts the WHOLE message list, taking
      // every other message with it.
      const lc = aguiMessagesToLangChain([
        {
          id: "non-string-mime",
          role: "user",
          content: [{ type: "binary", mimeType: 42, data: "aGk=" }],
        } as unknown as UserMessage,
      ]);

      expect(lc[0].content).toEqual([{ type: "image_url", image_url: { url: "data:;base64,aGk=" } }]);
    });
  });

  // ── Native LangChain.js blocks on the way back ───────────────────────────
  describe("langchainMessagesToAgui with native LangChain.js blocks", () => {
    // EVERY standard block kind the return leg claims to understand, not just
    // `file`. The map behind this is what keeps a non-image attachment in a
    // reopened thread: a kind missing from it matches no branch of the
    // converter at all, so the block is not converted, not warned about and not
    // dropped loudly — it is simply absent from the next MESSAGES_SNAPSHOT,
    // which is what the thread permanently becomes. Testing only the `file` row
    // left the audio and video rows deletable with the suite green.
    //
    // Mirrored in Python by
    // `test_every_standard_block_kind_comes_back_as_its_own_media_type`.
    it.each([
      ["audio", "audio/wav", "audio"],
      ["video", "video/mp4", "video"],
      ["image", "image/png", "image"],
      ["file", "application/pdf", "document"],
    ])("brings a standard %s block back as AG-UI %s content", (blockType, mimeType, aguiType) => {
      const agui = langchainMessagesToAgui([
        {
          id: `return-leg-${blockType}`,
          type: "human",
          content: [
            { type: blockType, source_type: "base64", data: "QUJD", mime_type: mimeType },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content).toEqual([
        { type: aguiType, source: { type: "data", value: "QUJD", mimeType } },
      ]);
    });

    it("names a MIME-less inbound base64 block's bytes octet-stream", () => {
      // A base64 block with no MIME type is malformed rather than merely terse,
      // but an AG-UI data source REQUIRES one, so the attachment is kept under
      // the canonical name for unidentified bytes instead of being dropped.
      //
      // It has to be THAT string and not merely some placeholder: the outbound
      // leg emits exactly `application/octet-stream` for a MIME-less document,
      // and `FILENAME_EXTENSIONS` maps it to the same `.bin` the generic
      // derivation independently produces. The two legs are inverses only while
      // both spell it the same way. Mirrored in Python by
      // `test_base64_block_without_mime_type_is_not_dropped`.
      const agui = langchainMessagesToAgui([
        {
          id: "inbound-no-mime",
          type: "human",
          content: [{ type: "file", source_type: "base64", data: "JVBERi0xLjQK" }],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content).toEqual([
        {
          type: "document",
          source: {
            type: "data",
            value: "JVBERi0xLjQK",
            mimeType: "application/octet-stream",
          },
        },
      ]);
    });

    it("accepts a native JS file block", () => {
      const agui = langchainMessagesToAgui([
        {
          id: "native-file",
          type: "human",
          content: [
            { type: "text", text: "Summarize this" },
            {
              type: "file",
              data: "JVBERi0xLjQK",
              mimeType: "application/pdf",
              metadata: { filename: "invoice-q2.pdf" },
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[1]).toEqual({
        type: "document",
        source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
        metadata: { filename: "invoice-q2.pdf" },
      });
    });

    it("keeps MIME type and filename on a native JS file block by url", () => {
      const agui = langchainMessagesToAgui([
        {
          id: "native-url",
          type: "human",
          content: [
            {
              type: "file",
              url: "https://example.com/doc.pdf",
              mimeType: "application/pdf",
              metadata: { filename: "doc.pdf" },
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[0]).toEqual({
        type: "document",
        source: { type: "url", value: "https://example.com/doc.pdf", mimeType: "application/pdf" },
        metadata: { filename: "doc.pdf" },
      });
    });

    it("still accepts a Python-shaped block, because the graph may be Python", () => {
      // This package drives a LangGraph server through
      // `@langchain/langgraph-sdk`, and that server is usually the Python one,
      // so a graph's own messages come back in Python's field names. Refusing
      // them would drop the attachment from MESSAGES_SNAPSHOT — the same bug,
      // mirrored onto the return leg.
      const agui = langchainMessagesToAgui([
        {
          id: "python-shaped",
          type: "human",
          content: [
            {
              type: "file",
              base64: "JVBERi0xLjQK",
              mime_type: "application/pdf",
              filename: "invoice-q2.pdf",
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[0]).toEqual({
        type: "document",
        source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
        metadata: { filename: "invoice-q2.pdf" },
      });
    });

    it("drops a fileId-only block loudly rather than inventing a source", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agui = langchainMessagesToAgui([
        {
          id: "file-id-only",
          type: "human",
          content: [{ type: "file", fileId: "file-abc123", mimeType: "application/pdf" }],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropping file block"));
      warn.mockRestore();
    });

    it("ignores a block whose type is an Object.prototype key", () => {
      // `item.type` is not author-controlled: it rides in on content blocks the
      // LangGraph server relays from model and tool output. A bare bracket
      // lookup into an object literal answers "constructor" / "toString" with an
      // INHERITED FUNCTION, which is truthy, so the media branch would be
      // entered and that function written out as the AG-UI content type — a
      // malformed item that fails schema validation downstream. A prototype key
      // has to be exactly as unrecognized as any other unknown block type:
      // skipped, leaving only the blocks this converter actually understands.
      //
      // "Skipped" is not "silent". Each of the five is a DROP, and rule 2 of the
      // malformed-input contract requires exactly one warning per dropped item —
      // so the drops are asserted here rather than left unexamined. Without that
      // assertion this test passed whether the converter announced the drops or
      // swallowed them, which is the regression the contract exists to stop. The
      // announcements are STUBBED for the reason given on "should skip media
      // content with unknown source type": left live they wrote five lines to the
      // suite's stderr on every run, training everyone reading CI output to
      // ignore a line the converter emits precisely so a vanished attachment is
      // traceable.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agui = langchainMessagesToAgui([
        {
          id: "prototype-typed",
          type: "human",
          content: [
            { type: "text", text: "before" },
            { type: "constructor", data: "JVBERi0xLjQK", mimeType: "application/pdf" },
            { type: "toString", url: "https://example.com/doc.pdf" },
            { type: "valueOf", base64: "JVBERi0xLjQK", mime_type: "audio/mpeg" },
            { type: "hasOwnProperty", data: "JVBERi0xLjQK" },
            { type: "isPrototypeOf", data: "JVBERi0xLjQK" },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content).toEqual([{ type: "text", text: "before" }]);
      expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
        '[convertLangchainMultimodalToAgui] Dropping unsupported content block of type "constructor"',
        '[convertLangchainMultimodalToAgui] Dropping unsupported content block of type "toString"',
        '[convertLangchainMultimodalToAgui] Dropping unsupported content block of type "valueOf"',
        '[convertLangchainMultimodalToAgui] Dropping unsupported content block of type "hasOwnProperty"',
        '[convertLangchainMultimodalToAgui] Dropping unsupported content block of type "isPrototypeOf"',
      ]);
      warn.mockRestore();
    });

    it("falls through an empty metadata.filename to metadata.name", () => {
      // The lookup used to be a `??` chain, and `??` falls through on
      // null/undefined ONLY — so an empty `metadata.filename` stopped it dead
      // and threw away the name `metadata.name` was carrying. Python's
      // `_incoming_block_filename` always scanned for the first NON-EMPTY
      // string; this is the divergence closed.
      const agui = langchainMessagesToAgui([
        {
          id: "empty-then-name",
          type: "human",
          content: [
            {
              type: "file",
              source_type: "base64",
              data: "JVBERi0xLjQK",
              mime_type: "application/pdf",
              metadata: { filename: "", name: "report.pdf", title: "Q2" },
            },
            {
              type: "file",
              source_type: "base64",
              data: "JVBERi0xLjQK",
              mime_type: "application/pdf",
              metadata: { filename: "", name: "", title: "from-title.pdf" },
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[0].metadata).toEqual({ filename: "report.pdf" });
      expect(content[1].metadata).toEqual({ filename: "from-title.pdf" });
    });

    it("does not let a derived filename come back as a user-supplied one", () => {
      // The outbound leg INVENTS a name for every filename-less document,
      // because the provider translator needs one. If the return leg writes that
      // name into AG-UI `metadata.filename`, the thread now asserts the user
      // attached a file called `attachment.txt` — and because a supplied name
      // always beats derivation, the invention is frozen into every later send.
      //
      // The invented name is exactly `deriveFilename(mime_type)`, so recomputing
      // it identifies it. A REAL name is untouched, which is the other half.
      const emitted = aguiMessagesToLangChain([
        {
          id: "derived-out",
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "data", value: "aGk=", mimeType: "text/plain" },
            } as DocumentInputContent,
            {
              type: "document",
              source: { type: "data", value: "aGk=", mimeType: "text/plain" },
              metadata: { filename: "notes.txt" },
            } as DocumentInputContent,
          ],
        } as UserMessage,
      ])[0].content as Array<any>;

      // Pinned: what goes OUT still carries the derived name, because dropping
      // it there is the throw this whole path exists to avoid.
      expect(emitted[0].metadata).toEqual({ filename: "attachment.txt" });

      const back = (
        langchainMessagesToAgui([
          { id: "derived-out", type: "human", content: emitted } as unknown as LangGraphMessage,
        ])[0] as UserMessage
      ).content as Array<any>;

      expect(back[0]).toEqual({
        type: "document",
        source: { type: "data", value: "aGk=", mimeType: "text/plain" },
      });
      expect(back[0].metadata).toBeUndefined();
      expect(back[1].metadata).toEqual({ filename: "notes.txt" });
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

// ── The cross-runtime parity table ─────────────────────────────────────────
//
// The mechanism that makes DRIFT fail a test instead of surviving to review.
//
// This adapter exists twice — once here, once in `ag_ui_langgraph/utils.py` —
// implementing one contract as two independent bodies of code. Three review
// rounds found the same class of defect fixed on one side and not mirrored to
// the other; nothing in either suite could see it, because each runtime pinned
// behaviour the other left unpinned, so every divergence survived until a human
// read both files side by side.
//
// `../../cross-runtime-parity-cases.json` is the shared table both suites read.
// It is the single source of truth for the CASES and for the EXPECTED OUTCOME:
// a case added there is picked up by this suite and by Python's
// `TestCrossRuntimeParityTable` with no edit to either. There is deliberately no
// second list to keep in sync — hand-mirroring is the exact failure this exists
// to prevent.
//
// Read the `readme` array at the top of that file before adding a case.
describe("cross-runtime parity table", () => {
  interface ParityCase {
    id: string;
    direction: "inbound" | "outbound";
    axis: string;
    why: string;
    content: unknown[];
    /**
     * What the PYTHON harness builds each outbound item into. Declared so this
     * runtime does not silently ignore a field of the shared table, but not read
     * here: nothing validates content at this boundary in TypeScript, so there is
     * no equivalent to record. Python asserts it — see
     * `test_outbound_cases_record_what_this_runtime_actually_builds`.
     */
    pythonBuilds?: string[];
    /**
     * How the PYTHON harness builds this case's items — `"unvalidated"` means
     * `model_construct`, so a payload AG-UI's schema refuses still reaches the
     * typed branch there. Declared so this runtime does not silently ignore a
     * field of the shared table, but not read here: nothing validates content at
     * this boundary in TypeScript, so every case already arrives as the raw JSON
     * the table records and there is nothing to bypass.
     */
    pythonBuild?: "unvalidated";
    expect: { kept: unknown[]; dropped: number; loggedDrops: number };
  }

  const table: { readme: string[]; cases: ParityCase[] } = JSON.parse(
    readFileSync(new URL("../../cross-runtime-parity-cases.json", import.meta.url), "utf8"),
  );

  /**
   * Project this runtime's output onto the table's neutral vocabulary.
   *
   * SHAPE ONLY. The two runtimes emit the same content under deliberately
   * different keys — see {@link StandardMediaBlock} in `utils.ts` — and that
   * difference is documented, not drift. Everything else survives the
   * projection: a different VALUE, a different survivor, or a different count
   * still fails. Nothing here inspects the input, so no case can be normalized
   * into agreement.
   *
   * `sourceType` is the RECOGNITION MARKER, and it is projected rather than
   * dropped. It is the key that makes a translator see the block as inline
   * base64 media at all: here `source_type: "base64"` (`@langchain/core`'s
   * `isDataContentBlock` tests for `source_type` and nothing else), in Python
   * the `base64` key itself (measured on `langchain-core` 1.2.13,
   * `is_data_content_block` returns `True` on `"base64" in block`). Deleting
   * that key from either emitted block sends the provider a block its
   * translator does not recognize as media — the failure the outbound design
   * exists to prevent — and while it was projected away this table could not
   * see it happen.
   */
  function canonical(direction: string, items: any[]): unknown[] {
    if (direction === "inbound") {
      return items.map((item) =>
        item.type === "text"
          ? { kind: "text", text: item.text }
          : {
              kind: item.type,
              source: item.source?.type,
              value: item.source?.value,
              mimeType: item.source?.mimeType || null,
              filename: item.metadata?.filename || null,
            },
      );
    }
    return items.map((block) => {
      if (block.type === "text") return { kind: "text", text: block.text };
      if (block.type === "image_url") return { kind: "image_url", url: block.image_url?.url };
      return {
        kind: "standard",
        blockType: block.type,
        sourceType: block.source_type ?? ("base64" in block ? "base64" : null),
        data: block.data,
        mimeType: block.mime_type || null,
        filename: block.metadata?.filename || null,
      };
    });
  }

  /**
   * A module prefix on a log line, e.g. `[convertAguiMultimodalToLangchain] `.
   *
   * Stripped before the drop rule is applied, NOT matched around. This runtime
   * prefixes every line with the emitting function and Python's `getMessage()`
   * carries no prefix at all, and that difference is the whole reason the two
   * harnesses ended up enforcing different rules: this one had loosened to a
   * substring match (`/Dropping /`, matching anywhere in the line) while
   * Python kept `startswith("Dropping ")`, and both comments claimed the
   * `startswith` rule. A line that MENTIONS "Dropping " somewhere in its prose
   * without being a drop announcement was counted here and not there.
   * Normalize the prefix away, then apply the one rule on the one form.
   */
  const LOG_MODULE_PREFIX = /^\[[^\]]*\]\s*/;

  /**
   * Rule 2 of the malformed-input contract: warnings that BEGIN "Dropping ",
   * once the runtime's own module prefix is removed.
   *
   * The rest of the prose legitimately differs between the runtimes (`int` vs
   * `number`, `dict` vs `object`), so asserting it would fail on wording rather
   * than on behaviour. Kept byte-identical to Python's `_count_drop_logs`.
   */
  function countDropLogs(warnings: string[]): number {
    return warnings.filter((line) => line.replace(LOG_MODULE_PREFIX, "").startsWith("Dropping "))
      .length;
  }

  /** Drive one converter over one content list and capture what it logged. */
  function convert(direction: string, content: unknown[]) {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
    try {
      const converted =
        direction === "inbound"
          ? (
              langchainMessagesToAgui([
                { id: "parity", type: "human", content } as unknown as LangGraphMessage,
              ])[0] as UserMessage
            )?.content
          : aguiMessagesToLangChain([
              { id: "parity", role: "user", content } as unknown as UserMessage,
            ])[0]?.content;
      return { items: Array.isArray(converted) ? converted : [], warnings };
    } finally {
      warn.mockRestore();
    }
  }

  /**
   * Run one case and reduce it to the outcome triple the table records.
   *
   * `dropped` IS MEASURED, NOT DERIVED. It used to be `content.length -
   * kept.length`, which is arithmetic on `kept`: it could not fail unless
   * `kept` had already failed, so the table's third axis was one axis with two
   * names. Here each input item is removed in turn and the converter re-run:
   * an item whose removal leaves the output the same LENGTH produced nothing,
   * and that is what "dropped" means. It is a measurement of the item, not of
   * the list, so it fails on its own — a run that drops one item while emitting
   * a second block for another nets to the right length and is caught here.
   * Blind spot, stated because it is real: two items that convert identically
   * are indistinguishable by this method (removing either shortens the output
   * by one), so provenance between duplicates is not pinned.
   *
   * A THROW is reported here rather than allowed to escape as a bare stack: rule
   * 1 of the malformed-input contract is that no case in this table may throw in
   * either runtime, so a throw is a parity failure with a name, not an accident
   * of the harness.
   */
  function outcomeOf(testCase: ParityCase) {
    try {
      const full = convert(testCase.direction, testCase.content);
      const dropped = testCase.content.filter(
        (_, index) =>
          convert(
            testCase.direction,
            testCase.content.filter((__, other) => other !== index),
          ).items.length === full.items.length,
      ).length;
      return {
        kept: canonical(testCase.direction, full.items),
        dropped,
        loggedDrops: countDropLogs(full.warnings),
      };
    } catch (error) {
      throw new Error(
        `${report(testCase)}\n` +
          `  This runtime THREW ${String(error)}\n` +
          "  Rule 1 of the malformed-input contract is DROP, NEVER THROW — no case in\n" +
          "  the shared table may throw in either runtime, and the other one does not\n" +
          "  throw on this input.",
        { cause: error },
      );
    }
  }

  /**
   * The failure text. A bare boolean is useless to whoever hits this: it has to
   * say which case, what the shared table says both runtimes must produce, and
   * why the case is in the table at all.
   */
  function report(testCase: ParityCase) {
    return [
      `cross-runtime parity case "${testCase.id}" (${testCase.direction}, ${testCase.axis})`,
      `  why: ${testCase.why}`,
      `  input: ${JSON.stringify(testCase.content)}`,
      "  This runtime (TypeScript) disagrees with cross-runtime-parity-cases.json,",
      "  which records the outcome BOTH adapters must produce and which the Python",
      "  adapter produces today. Fix the runtime that is wrong — do not split the",
      "  expectation.",
    ].join("\n");
  }

  const inboundCases = table.cases.filter((c) => c.direction === "inbound");
  const outboundCases = table.cases.filter((c) => c.direction === "outbound");

  it("reads a non-empty shared table", () => {
    // A path typo or a truncated file would otherwise turn every parity
    // assertion below into zero assertions, silently.
    expect(inboundCases.length).toBeGreaterThan(0);
    expect(outboundCases.length).toBeGreaterThan(0);
  });

  it.each(inboundCases.map((c) => [c.id, c] as const))(
    "inbound %s",
    (_id, testCase) => {
      expect(outcomeOf(testCase), report(testCase)).toEqual(testCase.expect);
    },
  );

  it.each(outboundCases.map((c) => [c.id, c] as const))(
    "outbound %s",
    (_id, testCase) => {
      expect(outcomeOf(testCase), report(testCase)).toEqual(testCase.expect);
    },
  );
});
