/** Helpers for turning Managed Agents content blocks into display text. */

import { SEARCH_RESULT_PREVIEW_CHARS } from "./constants";

/** Any content block; only `type` is required to route it. */
type ContentBlock = { type: string } & Record<string, any>;

/** U+FFFD, substituted for any entity that does not denote a usable character. */
const REPLACEMENT_CHARACTER = "�";

/**
 * The character an entity's code point denotes, or U+FFFD.
 *
 * Surrogate code points (U+D800–U+DFFF) are rejected as well as out-of-range
 * ones: alone they make the string ill-formed UTF-16, which cannot be encoded
 * as UTF-8 and turns into U+FFFD (or an encoder error) somewhere downstream.
 * Substituting here keeps every port's output well-formed and identical.
 */
const codePointOf = (n: number): string =>
  Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : REPLACEMENT_CHARACTER;

const NAMED_ENTITIES: Record<string, string> = { quot: '"', lt: "<", gt: ">", amp: "&" };

/** Numeric (hex or decimal) and the handful of named entities, in one alternation. */
const ENTITY_PATTERN = /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(quot|lt|gt|amp));/g;

/**
 * Decode HTML entities in one pass.
 *
 * One pass matters: decoding numeric entities before named ones would rewrite
 * `&#38;lt;` to `&lt;` and then to `<`, losing the escaping the source went to
 * the trouble of writing. Each match is resolved exactly once, so `&#38;lt;`
 * decodes to the literal `&lt;`.
 */
export const decodeEntities = (s: string): string =>
  s.replace(ENTITY_PATTERN, (_match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name]!;
    return codePointOf(hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10));
  });

/** Concatenate the text of every `text` block. */
export const textOf = (content: ReadonlyArray<ContentBlock> | null | undefined): string =>
  (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

/**
 * Tool results mix block types: text, search results, images, documents.
 * Flatten them into a readable string for the UI.
 *
 * `text` blocks are passed through verbatim. They carry literal tool output —
 * a file read, a shell transcript — where `&lt;` means those four characters,
 * so decoding them would corrupt the very output the user asked to see. Only
 * `search_result` blocks, whose bodies are extracted from HTML, are decoded.
 */
export const describeToolResult = (content: ReadonlyArray<ContentBlock> | null | undefined): string =>
  (content ?? [])
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text as string;
      if (block.type === "search_result") {
        const inner = Array.isArray(block.content) ? textOf(block.content) : "";
        const title = decodeEntities(String(block.title ?? ""));
        const source = String(block.source ?? "");
        return `[search result] ${title} — ${source}${inner ? `\n${decodeEntities(inner).slice(0, SEARCH_RESULT_PREVIEW_CHARS)}` : ""}`;
      }
      return `[${String(block.type)}]`;
    })
    .join("\n")
    .trim();
