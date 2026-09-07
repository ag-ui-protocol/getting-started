/**
 * Model citations, folded onto the assistant message they annotate.
 *
 * When a model answers over documents with citations enabled, it returns the
 * source passages its answer came from. Strands surfaces them as
 * `citationsDelta` deltas, and Bedrock emits them between the text deltas of
 * one assistant turn, so a citation arrives in the middle of the message it
 * belongs to rather than at the end of the run. Whether the citation shares a
 * content block with the text it supports is a provider detail this adapter
 * does not depend on: the Bedrock streaming path keeps them in the same block,
 * while the OpenAI Responses adapter closes the text block first.
 *
 * They ride the assistant message's own `metadata` under
 * {@link CITATIONS_METADATA_KEY}, which is what keeps a citation attached to
 * the thing it annotates. A separate event stream would hand the frontend two
 * sequences and the job of correlating them.
 *
 * The normalisation below is written against `citations.py` in the Python
 * adapter, field for field, because the two are expected to produce equal
 * objects for the same Bedrock response. Where they cannot agree, the
 * difference is named in the docstring that owns it rather than left for a
 * reader to discover.
 */

import { DEFAULT_LOGGER, type Logger } from "./logger";

/**
 * Metadata key carrying the citation list on an assistant message.
 *
 * Deliberately not nested under AG-UI's reserved `ag-ui` key. That key is
 * reserved for the protocol's own values, and metadata merging replaces a key's
 * value wholesale rather than blending it, so a second writer under `ag-ui`
 * would silently destroy whatever the protocol had put there.
 */
export const CITATIONS_METADATA_KEY = "citations";

/**
 * Location kinds whose Bedrock wrapper key differs from the discriminator this
 * SDK produces for the same location.
 *
 * Only one differs today. Verified against the published SDK's
 * `_mapBedrockCitationLocation`: Bedrock wraps a search-result location in
 * `searchResultLocation` and the SDK emits `type: "searchResult"`, while
 * `documentChar`, `documentPage`, `documentChunk` and `web` keep their names.
 * Mirrors `_LOCATION_KIND_ALIASES` in the Python adapter.
 */
const LOCATION_KIND_ALIASES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  { searchResultLocation: "searchResult" },
);

/**
 * Where a cited passage sits in its source.
 *
 * Mirrors the SDK's own `CitationLocation` union. Kept open-ended with a
 * catch-all member because the Python adapter forwards a kind neither SDK
 * names yet, and a consumer switching on `type` should still compile against
 * one.
 */
export type AguiCitationLocation =
  | {
      type: "documentChar" | "documentPage" | "documentChunk";
      documentIndex: number;
      start: number;
      end: number;
    }
  | {
      type: "searchResult";
      searchResultIndex: number;
      start: number;
      end: number;
    }
  | { type: "web"; url: string; domain?: string }
  | { type: string; [field: string]: unknown };

/** A citation as it reaches the client, under {@link CITATIONS_METADATA_KEY}. */
export interface AguiCitation {
  /** Title of the cited source, when the provider supplies one. */
  title?: string;
  /**
   * Source identifier, typically a URL.
   *
   * Bedrock does not send one, so this is absent on the Bedrock path in both
   * bridges. The SDK's OpenAI Responses adapter fills it with the cited URL.
   */
  source?: string;
  /** The passage in the source document that supports the answer. */
  sourceContent?: { text: string }[];
  /** Where the passage sits in the source. */
  location?: AguiCitationLocation;
  /**
   * The generated text this citation supports, where the provider reports it.
   *
   * The one field the two bridges cannot always agree on. Strands reports it on
   * the delta rather than on the citation, and only some providers populate it:
   * the SDK's OpenAI Responses adapter does, Bedrock sends an empty list. The
   * Python SDK's stream shape has no equivalent field at all, so a provider
   * that supplies a generated span reaches a TypeScript client with `content`
   * and a Python client without it.
   *
   * It does not count towards a citation naming a source. A marker carrying
   * only the text it annotates points a reader at nothing, so such a citation
   * is dropped in both adapters.
   */
  content?: { text: string }[];
  /**
   * Characters of this message's text streamed when the citation arrived,
   * counted in UTF-16 code units.
   *
   * This is the only positional information available. A citation locates a
   * span in the SOURCE document and says nothing about where in the answer it
   * belongs, so placing it in the answer relies on the provider emitting a
   * citation after the text it supports.
   *
   * Counted by {@link CitationAccumulator} rather than read off the adapter's
   * `accumulatedText`, which is reset only when message snapshots are being
   * emitted and would otherwise keep counting across messages.
   */
  textOffset: number;
}

/** The `citationsDelta` payload, as the SDK shapes it. */
interface CitationsDeltaLike {
  type?: string;
  citations?: unknown;
  content?: unknown;
}

/** Render an object's keys for a log line. */
function describeKeys(value: object): string {
  return Object.keys(value).sort().join(",");
}

/**
 * Return a citation location in discriminated form, or `undefined` if empty.
 *
 * This SDK flattens the location itself, but a custom model provider can
 * forward Bedrock's wrapped shape (`{ documentChar: { ... } }`) untouched,
 * which is also what the Python adapter receives. Both shapes arrive here and
 * both are reduced to the flattened one.
 *
 * Three rules, each mirrored in `citations.py`:
 *
 * - the wrapper key becomes `type`, renamed through
 *   {@link LOCATION_KIND_ALIASES} where this SDK uses a different name;
 * - fields the provider left empty or absent are dropped, matching the SDK,
 *   which omits a falsy `domain` rather than emitting it;
 * - a location that ends up naming only its kind is not a location.
 *
 * Anything that is not an object at all is not a location either. Python drops
 * those too, which is why a falsy scalar cannot rescue a citation here.
 */
function normalizeLocation(
  location: unknown,
): AguiCitationLocation | undefined {
  if (
    typeof location !== "object" ||
    location === null ||
    Array.isArray(location)
  ) {
    return undefined;
  }

  const keys = Object.keys(location);
  let flattened: Record<string, unknown> = {
    ...(location as Record<string, unknown>),
  };

  if (keys.length === 1) {
    const fields = (location as Record<string, unknown>)[keys[0]];
    if (
      typeof fields === "object" &&
      fields !== null &&
      !Array.isArray(fields) &&
      !("type" in fields)
    ) {
      flattened = {
        type: LOCATION_KIND_ALIASES[keys[0]] ?? keys[0],
        ...(fields as Record<string, unknown>),
      };
    }
  }

  // Null-prototype: a provider key of `__proto__` would otherwise hit the
  // prototype setter, silently dropping the field and taking its prototype
  // from provider data.
  const trimmed = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(flattened)) {
    if (value === undefined || value === null || value === "") continue;
    trimmed[key] = value;
  }

  // Anything that did not end up discriminated is not a location. Reached when
  // a wrapper's payload is not an object at all (`{ documentChar: "0-9" }`),
  // which would otherwise pass through as provider garbage and rescue a
  // citation that names no source. It is also what makes the cast below true.
  // Anything not discriminated by a non-empty string `type` is not a
  // location. Reached when a wrapper's payload is not an object at all
  // (`{ documentChar: "0-9" }`), which would otherwise pass through as provider
  // garbage and rescue a citation that names no source. It is also what makes
  // the cast below true rather than asserted.
  const trimmedKeys = Object.keys(trimmed);
  if (typeof trimmed.type !== "string" || !trimmed.type) return undefined;
  if (trimmedKeys.length === 1) return undefined;
  // Back onto a normal prototype. Belt and braces: the JSON round trip every
  // citation passes would restore it anyway, but this object is read by
  // `normalizeCitation` before that happens.
  return { ...trimmed } as AguiCitationLocation;
}

/**
 * Keep the non-empty `{ text }` entries of a citation content list.
 *
 * Dropping the empty ones is load-bearing for cross-language agreement: this
 * SDK coalesces a missing text to `""` where the Python one leaves the entry
 * out entirely.
 */
function textEntries(value: unknown): { text: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { text: string }[] = [];
  for (const entry of value) {
    const text = (entry as { text?: unknown } | null)?.text;
    if (typeof text === "string" && text) out.push({ text });
  }
  return out;
}

/**
 * Deep-copy a value, or return `undefined` if it will not survive JSON.
 *
 * Metadata rides an event that is encoded for the SSE stream, and a value that
 * will not encode fails the whole stream, costing the client its
 * `TEXT_MESSAGE_END`, snapshots and `RUN_FINISHED`. The replacer rejects
 * non-finite numbers explicitly because `JSON.stringify` would quietly turn
 * them into `null`, where the Python sibling's `allow_nan=False` raises; a
 * citation that cannot be represented is dropped in both. A bigint needs no
 * arm of its own: `JSON.stringify` throws on one already.
 */
export function jsonRoundTrip<T>(value: T): T | undefined {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "number" && !Number.isFinite(v)) {
          throw new TypeError("non-finite number");
        }
        return v;
      }),
    ) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reduce one SDK citation to the wire shape, or `undefined` to drop it.
 *
 * Empty strings, empty lists and empty locations are omitted rather than
 * emitted, so a citation identical on the provider side produces an equal
 * object in both bridges.
 *
 * A citation that names no source is dropped outright. `content` does not count
 * towards naming one: see {@link AguiCitation.content}.
 */
function normalizeCitation(
  citation: unknown,
  content: { text: string }[],
  textOffset: number,
  log: Logger,
): AguiCitation | undefined {
  if (
    typeof citation !== "object" ||
    citation === null ||
    Array.isArray(citation)
  ) {
    const kind =
      citation === null
        ? "null"
        : Array.isArray(citation)
          ? "array"
          : typeof citation;
    log.warn(
      `[@ag-ui/aws-strands] Dropping a citation that is not an object ` +
        `(got ${kind})`,
    );
    return undefined;
  }
  const source = citation as Record<string, unknown>;

  const entry: Partial<AguiCitation> = {};
  if (typeof source.title === "string" && source.title) {
    entry.title = source.title;
  }
  if (typeof source.source === "string" && source.source) {
    entry.source = source.source;
  }

  const location = normalizeLocation(source.location);
  if (location !== undefined) {
    entry.location = location;
  } else if (source.location) {
    // Kept, minus the location. A provider that sends an untagged shape still
    // named a source; dropping the whole citation over a field this adapter
    // cannot place would lose more than it protects.
    log.warn(
      `[@ag-ui/aws-strands] Omitting a citation location that is not in ` +
        `tagged form (${
          typeof source.location === "object" && !Array.isArray(source.location)
            ? `keys=${describeKeys(source.location as object)}`
            : typeof source.location
        }). A location must be either Bedrock's single-key wrapper or a ` +
        `discriminated object with a string \`type\`.`,
    );
  }

  const sourceContent = textEntries(source.sourceContent);
  if (sourceContent.length > 0) entry.sourceContent = sourceContent;

  if (Object.keys(entry).length === 0) {
    log.warn(
      `[@ag-ui/aws-strands] Dropping a citation carrying no source fields ` +
        `(keys=${describeKeys(source)})`,
    );
    return undefined;
  }

  if (content.length > 0) entry.content = content;

  const encodable = jsonRoundTrip({ ...entry, textOffset } as AguiCitation);
  if (encodable === undefined) {
    log.warn(
      `[@ag-ui/aws-strands] Dropping unserializable citation ` +
        `(keys=${describeKeys(entry)})`,
    );
  }
  return encodable;
}

/**
 * An independent copy of a citation metadata object.
 *
 * The event on the wire and the assistant message retained in the snapshot list
 * need separate copies. The retained message is re-emitted in every later
 * snapshot of the run, so a consumer mutating the list it received on
 * `TEXT_MESSAGE_END` would otherwise corrupt every snapshot after it.
 *
 * Every value here has already passed {@link jsonRoundTrip}, so this one cannot
 * fail on content the module produced.
 */
export function copyCitationMetadata(
  metadata: Record<string, AguiCitation[]> | undefined,
  log: Logger = DEFAULT_LOGGER,
): Record<string, AguiCitation[]> | undefined {
  if (metadata === undefined) return undefined;
  const copied = jsonRoundTrip(metadata);
  if (copied === undefined) {
    log.warn(
      `[@ag-ui/aws-strands] Dropping a citation list that no longer encodes`,
    );
  }
  return copied;
}

/**
 * Collects the citations of one assistant message.
 *
 * The accumulator also owns the running text offset. It deliberately does not
 * read the adapter's `accumulatedText`: that variable is reset only when
 * message snapshots are being emitted, so an offset derived from it would keep
 * counting across messages whenever snapshots are off.
 *
 * A message's citations are published as a complete list every time, because
 * metadata merging replaces a key's value rather than appending to it. So each
 * publish carries every citation seen so far for the open message, and a client
 * always holds a whole prefix rather than a fragment.
 */
export class CitationAccumulator {
  private items: AguiCitation[] = [];
  private unpublished = false;
  private offset = 0;

  constructor(private readonly log: Logger = DEFAULT_LOGGER) {}

  /**
   * Record text emitted for the open message.
   *
   * `String.prototype.length` counts UTF-16 code units, which is what a browser
   * client will slice with. The Python adapter counts the same units rather
   * than its own characters, so the two agree on text containing an emoji.
   */
  advance(delta: string): void {
    this.offset += delta.length;
  }

  /**
   * Record the citations in a `citationsDelta`, or return false if the delta is
   * not one.
   *
   * A single delta can carry several citations. `content` is a property of the
   * delta rather than of each citation, so every citation in it gets the same
   * generated span.
   *
   * Returning true claims the delta even when every citation in it was
   * unusable, because the delta IS a citation delta and the adapter has a
   * branch for it. Each drop is warned about individually rather than handing
   * the payload to the RAW fallback, which exists for events with no branch.
   */
  add(delta: unknown): boolean {
    const candidate = delta as CitationsDeltaLike | null;
    if (candidate?.type !== "citationsDelta") return false;

    const content = textEntries(candidate.content);
    if (!Array.isArray(candidate.citations)) {
      this.log.warn(
        `[@ag-ui/aws-strands] Ignoring a citationsDelta whose citations field ` +
          `is ${candidate.citations === undefined ? "absent" : "not an array"}`,
      );
      return true;
    }
    if (candidate.citations.length === 0) {
      this.log.warn(
        `[@ag-ui/aws-strands] Ignoring a citationsDelta carrying no citations`,
      );
      return true;
    }
    for (const citation of candidate.citations) {
      const entry = normalizeCitation(citation, content, this.offset, this.log);
      if (entry === undefined) continue;
      this.items.push(entry);
      this.unpublished = true;
    }
    return true;
  }

  /**
   * Metadata to attach mid-stream, or `undefined` if nothing is new.
   *
   * Returning `undefined` once published is what stops every remaining text
   * delta of the message from re-sending an unchanged list.
   */
  pending(): Record<string, AguiCitation[]> | undefined {
    if (!this.unpublished) return undefined;
    const metadata = this.metadata();
    // Cleared only once the copy succeeded, so a build that failed is retried
    // on the next delta rather than being swallowed with the flag. Defensive
    // rather than covered: every entry already survived the identical round
    // trip on the way in, so nothing this module produces can fail here.
    if (metadata !== undefined) this.unpublished = false;
    return metadata;
  }

  /**
   * An independent copy of every citation collected so far, or `undefined`.
   *
   * A fresh copy each call, so a consumer holding an earlier publish cannot see
   * a later one mutate underneath it.
   */
  metadata(): Record<string, AguiCitation[]> | undefined {
    if (this.items.length === 0) return undefined;
    const copied = jsonRoundTrip(this.items);
    if (copied === undefined) {
      // Unreachable on content this module produced: every entry already
      // passed the same round trip on the way in. Handled rather than asserted
      // away so a future change that admits a raw value cannot ship a
      // `{ citations: undefined }` payload.
      this.log.warn(
        `[@ag-ui/aws-strands] Dropping ${this.items.length} citation(s) that ` +
          `no longer encode`,
      );
      return undefined;
    }
    return { [CITATIONS_METADATA_KEY]: copied };
  }

  /** How many citations are held for the open message. */
  get size(): number {
    return this.items.length;
  }

  /**
   * Metadata for the closing message, resetting for the next one.
   *
   * Both the `TEXT_MESSAGE_END` event and the assistant message inside the
   * following `MESSAGES_SNAPSHOT` need this value, and they need separate
   * copies of it: see {@link copyCitationMetadata}.
   *
   * Callers drain this at every message boundary, including boundaries where no
   * message was open, so citations cannot survive into the next message. See
   * {@link discardOrphanCitations}.
   */
  take(): Record<string, AguiCitation[]> | undefined {
    const metadata = this.metadata();
    this.items = [];
    this.unpublished = false;
    this.offset = 0;
    return metadata;
  }
}

/**
 * Drop citations collected while no assistant message was open.
 *
 * Reached when a turn produces citations and no text. There is no message for
 * them to annotate, and carrying them forward would attach one message's
 * sources to the next one at a meaningless offset, so they are dropped. The
 * warning exists because a silent drop here is indistinguishable from the model
 * never citing anything.
 *
 * Always drains, even when there is nothing to drop, so the offset resets at
 * every message boundary rather than only at the ones that had citations.
 */
export function discardOrphanCitations(
  citations: CitationAccumulator,
  context: string | undefined,
  log: Logger,
): void {
  const dropped = citations.size;
  citations.take();
  if (dropped === 0) return;
  log.warn(
    `[@ag-ui/aws-strands] Dropping ${dropped} citation(s) that arrived with no ` +
      `open assistant message (${context})`,
  );
}

/**
 * Spread helper so an event carries `metadata` only when there is something to
 * say. `JSON.stringify` already omits an explicit `metadata: undefined`, but
 * the object is also handed to in-process consumers and to the protobuf
 * encoder, where a present-but-undefined key is not the same as an absent one.
 */
export function citationMetadata(
  metadata: Record<string, AguiCitation[]> | undefined,
): { metadata?: Record<string, AguiCitation[]> } {
  return metadata === undefined ? {} : { metadata };
}
