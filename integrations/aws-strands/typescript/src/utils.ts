/** Utility functions for AWS Strands integration. */

import type {
  InputContent,
  TextInputContent,
  ImageInputContent,
  DocumentInputContent,
  VideoInputContent,
  InputContentSource,
} from "@ag-ui/core";
import {
  ImageBlock,
  DocumentBlock,
  VideoBlock,
  TextBlock,
  type ContentBlock,
  type ImageFormat,
  type DocumentFormat,
  type VideoFormat,
} from "@strands-agents/sdk";
import { DEFAULT_LOGGER, type Logger } from "./logger";

const LOG_PREFIX = "[@ag-ui/aws-strands]";

// Allowed formats per media type for Strands ContentBlock
const IMAGE_FORMATS = new Set<string>(["png", "jpeg", "gif", "webp"]);
// `3gp` is the SDK's spelling: its Bedrock provider translates that to
// Bedrock's own `three_gp` on the way out, so emitting `three_gp` here would
// skip the translation and hand every other provider a format it does not
// know.
//
// Documents are the opposite case. The SDK's `DocumentFormat` union also
// carries `json` and `xml`, but document formats reach Bedrock UNtranslated
// and Bedrock's own enum has neither, so accepting them would turn one
// unsupported attachment into a rejected request. Dropping the attachment
// loses less than failing the turn, so this list stays Bedrock's.
const DOCUMENT_FORMATS = new Set<string>([
  "pdf",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "html",
  "txt",
  "md",
]);
const VIDEO_FORMATS = new Set<string>([
  "flv",
  "mkv",
  "mov",
  "mpeg",
  "mpg",
  "mp4",
  "3gp",
  "webm",
  "wmv",
]);

/**
 * MIME subtypes that do not spell the Strands format string they mean.
 *
 * Without these, most of the formats the sets above claim to support are
 * unreachable: `text/plain` parses to `plain`, not `txt`, and the registered
 * subtypes for Word, Excel, Matroska and 3GPP (`msword`, `vnd.ms-excel`,
 * `x-matroska`, `3gpp`) do not match the format strings `doc`, `xls`, `mkv` or
 * `3gp` that the sets are keyed on. The mapping is a superset of the
 * Python sibling's, which covers the document and image entries but not the
 * video ones.
 */
const MIME_FORMAT_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    // Documents
    plain: "txt",
    markdown: "md",
    "x-markdown": "md",
    msword: "doc",
    "vnd.ms-excel": "xls",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    // Images
    jpg: "jpeg",
    // Videos
    "3gpp": "3gp",
    quicktime: "mov",
    "x-matroska": "mkv",
    "x-flv": "flv",
    "x-ms-wmv": "wmv",
  }),
);

/**
 * Split a MIME type into its family and subtype, or null if it is not one.
 *
 * Parameters are stripped first: `text/plain; charset=utf-8` carries the same
 * subtype as `text/plain`, and reading a slash-separated segment out of the
 * whole string would otherwise yield `plain; charset=utf-8` and fail.
 *
 * Exactly one slash is required. Taking the family from the front and the
 * subtype from the back independently would let a value carrying two types,
 * such as the `text/html, application/pdf` a merged duplicate header produces,
 * satisfy a family check with one of them and supply its format from the
 * other.
 */
function parseMime(
  mimeType: string,
): { topLevel: string; subtype: string } | null {
  const essence = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  const parts = essence.split("/");
  if (parts.length !== 2) return null;
  const [topLevel, subtype] = parts as [string, string];
  if (!topLevel || !subtype) return null;
  return { topLevel: topLevel.trim(), subtype: subtype.trim() };
}

/** Resolve an already-parsed subtype to a format in `allowed`, or null. */
function formatFromSubtype(
  subtype: string,
  allowed: Set<string>,
): string | null {
  const fmt = MIME_FORMAT_ALIASES[subtype] ?? subtype;
  return allowed.has(fmt) ? fmt : null;
}

/** Parse a MIME type into a short format string; returns null if absent or unsupported. */
function mimeToFormat(
  mimeType: string | undefined | null,
  allowed: Set<string>,
  log: Logger,
  where?: string,
  preparsed?: { topLevel: string; subtype: string },
): string | null {
  const at = where ? ` (${where})` : "";
  if (!mimeType) {
    log.warn(
      `${LOG_PREFIX} No MIME type provided${at}, cannot determine format`,
    );
    return null;
  }
  const parsed = preparsed ?? parseMime(mimeType);
  if (!parsed) {
    log.warn(
      `${LOG_PREFIX} Unusable MIME type '${forLog(mimeType)}'${at}: not a single type/subtype pair`,
    );
    return null;
  }
  const fmt = formatFromSubtype(parsed.subtype, allowed);
  if (fmt) {
    return fmt;
  }
  log.warn(
    `${LOG_PREFIX} Unsupported MIME type '${forLog(mimeType)}'${at} (parsed format '${forLog(MIME_FORMAT_ALIASES[parsed.subtype] ?? parsed.subtype)}' not in ${JSON.stringify([...allowed].sort())})`,
  );
  return null;
}

/**
 * Raised when the policy refuses a URL on its merits: a disallowed scheme,
 * userinfo, an address outside the permitted ranges, a redirect that cannot be
 * re-validated or that downgrades to cleartext, too many redirects, or a body
 * past the size cap. These are logged at `error` level, so the signal stays
 * specific to a request that was actually turned away.
 *
 * Part of the package's public API, re-exported from `src/index.ts`, so a host
 * configuring `StrandsAgentConfig.urlFetchPolicy` can identify a refusal it
 * caused. Unlike its neighbours here it therefore carries no internal-only
 * marker: `stripInternal` is on, and a marked declaration is dropped from the
 * emitted types, which makes it unexportable from the entry. Do not add one
 * back without removing the re-export.
 */
export class UrlFetchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlFetchPolicyError";
  }
}

/**
 * Raised when the policy cannot reach a verdict, so the fetch fails closed: a
 * resolver that errored, returned nothing, or returned something unparseable,
 * or a lookup that outlived the request deadline. Kept separate from
 * {@link UrlFetchPolicyError} because a transient DNS failure is not a refusal
 * and should not appear as one.
 *
 * @internal not part of the package's public API; exported for tests.
 */
export class UrlFetchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlFetchUnavailableError";
  }
}

// `node:crypto` is loaded on demand, like the other builtins here, to keep the
// main entry free of server-only dependencies.
let cryptoModule: typeof import("node:crypto") | undefined;

/**
 * Render a URL for a log line as an opaque, stable identifier.
 *
 * No component of the URL survives. Stripping the query and userinfo is not
 * enough: a capability URL puts its bearer material in the path, and some
 * systems put a tenant identifier or a secret in a subdomain, so the host and
 * path are no safer than the query. The digest is stable, so repeated failures
 * for the same URL can still be correlated with each other and, given the URL,
 * confirmed by hand.
 *
 */
function describeUrl(url: string): string {
  if (!cryptoModule) return "url<digest unavailable>";
  const digest = cryptoModule
    .createHash("sha256")
    .update(url, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `url#${digest}`;
}

/** Load the hash used by {@link describeUrl}. Called before any log line that names a URL. */
async function loadCrypto(): Promise<void> {
  cryptoModule ??= await import("node:crypto");
}

/**
 * Make a client-controlled value safe to interpolate into a log line.
 *
 * A newline in an attacker-chosen field would otherwise let them append lines
 * that impersonate this module's own refusal records.
 */
function forLog(value: unknown, max = 120): string {
  const text = String(value).replace(
    // The whole C0 range and DEL, the whole C1 range (which includes NEL at
    // U+0085 and the 8-bit CSI at U+009B), and the Unicode line and paragraph
    // separators. Several of these are treated as line breaks by log
    // consumers, and the escape introducers let a terminal sink be driven with
    // control sequences. Named individually, the set was missing U+001C to
    // U+001F, DEL and most of C1.
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,
    " ",
  );
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Strip anything secret out of third-party error text.
 *
 * Runtime errors quote the URL they were handed. Node's "cannot be constructed
 * from a URL that includes credentials" `TypeError` embeds the userinfo, and
 * `ERR_INVALID_URL` reports both `input` and `base`, either of which would put
 * a password or a presigned signature in the log despite every line this
 * module writes going through {@link describeUrl}.
 */
function scrubSecrets(text: string, ...urls: string[]): string {
  let out = text;
  for (const url of urls) {
    if (!url) continue;
    out = out.split(url).join(describeUrl(url));
    try {
      const parsed = new URL(url);
      // An error may quote a component without the whole URL, so the parts
      // that can carry secrets are removed individually as well.
      if (parsed.search.length > 1) out = out.split(parsed.search).join("");
      if (parsed.pathname.length > 1) {
        out = out.split(parsed.pathname).join("");
      }
      if (parsed.host) out = out.split(parsed.host).join("");
    } catch {
      // An unparseable URL has no components to strip individually.
    }
  }
  return forLog(out, 300);
}

/**
 * Policy applied to every server-side URL fetch.
 *
 * The defaults are deliberately restrictive: only `http`/`https` are fetched,
 * addresses outside the public internet (loopback, private, link-local -
 * notably the `169.254.169.254` cloud metadata endpoint - multicast and
 * reserved ranges) are refused, and the response body is capped. IPv6
 * transition forms that embed an IPv4 address are checked against the embedded
 * address too, so `::ffff:`, `::`, `2002::` and well-known NAT64 spellings of
 * a blocked target are refused as well. A NAT64 deployment using its own
 * network-specific prefix is not decoded; only the well-known and local-use
 * prefixes are. Note that under the default policy an IPv4-mapped host is
 * refused whatever it wraps, because the wrapper itself is not global unicast.
 *
 * The address check runs against the addresses `resolvedAddresses` sees. The
 * connection resolves the host again, so a host that changes its answer
 * between the two lookups is not covered; closing that would require pinning
 * the connection to the validated address.
 *
 * There is no port dimension: a host whose addresses are all public is
 * reachable on any port, as in the Python fix this mirrors (#2491).
 *
 * Relaxing the address checks is an explicit opt-in, and only ever the
 * host's: `StrandsAgentConfig.urlFetchPolicy` is threaded into every
 * conversion the adapter makes, and a direct `fetchUrlContent` caller can
 * pass one too. Nothing a client puts in a `RunAgentInput` reaches it, so
 * absent that configuration the defaults are what a consumer gets. Even under
 * `allowPrivateNetworks`, this-network, link-local ranges and the cloud
 * metadata endpoints listed in `ALWAYS_BLOCKED_IPV4`/`ALWAYS_BLOCKED_IPV6`
 * stay blocked; that list covers the major providers rather than every
 * provider.
 */
/** The NAT64 prefixes every deployment can be assumed to use. */
const WELL_KNOWN_NAT64_PREFIX = "64:ff9b::/96"; // RFC 6052
const LOCAL_USE_NAT64_PREFIX = "64:ff9b:1::/48"; // RFC 8215

export interface UrlFetchPolicy {
  readonly allowedSchemes: SchemeAllowlist;
  readonly allowPrivateNetworks: boolean;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  /**
   * Deployment-specific NAT64 prefixes, as `address/length` strings.
   *
   * An address under a recognised NAT64 prefix carries an IPv4 destination,
   * which is extracted and put through the full IPv4 policy, so a public
   * destination is reachable and a private or metadata one is not. RFC 6052
   * allows prefix lengths 32, 40, 48, 56, 64 and 96.
   *
   * The well-known `64:ff9b::/96` and local-use `64:ff9b:1::/48` prefixes are
   * always recognised and do not need listing; this field adds the
   * network-specific prefixes a deployment has chosen for itself.
   *
   * A network-specific prefix cannot be inferred from an address alone, so one
   * that is not listed here is not recognised as NAT64 and an address under it
   * is classified as ordinary global IPv6. An egress control has to cover that
   * case.
   */
  readonly nat64Prefixes: readonly string[];
}

/**
 * The membership test and iteration the policy needs from a scheme allowlist.
 *
 * Deliberately narrower than `ReadonlySet`: a plain `Set` satisfies it, so
 * callers can pass one, while the shared default can be an object with no
 * `Set` behind it. That matters because neither `Object.freeze` nor shadowing
 * `add` protects a real `Set` - its contents live in internal slots and
 * `Set.prototype.add.call(theSet, x)` reaches past any own property. It plays
 * the role the `frozenset` plays in the Python fix this mirrors (#2491).
 */
export interface SchemeAllowlist {
  has(scheme: string): boolean;
  [Symbol.iterator](): IterableIterator<string>;
}

function immutableSet(values: string[]): SchemeAllowlist {
  const items: readonly string[] = Object.freeze([...new Set(values)]);
  return Object.freeze({
    has: (scheme: string) => items.includes(scheme),
    [Symbol.iterator]: () => items[Symbol.iterator](),
  });
}

export const DEFAULT_URL_FETCH_POLICY: UrlFetchPolicy = Object.freeze({
  allowedSchemes: immutableSet(["http", "https"]),
  allowPrivateNetworks: false,
  maxBytes: 25 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 10,
  // The well-known and local-use prefixes are recognised unconditionally, so
  // this list holds only what a deployment adds.
  nat64Prefixes: Object.freeze([] as string[]),
});

type IpAddress = { version: 4 | 6; bytes: Uint8Array };

/** A `[prefixBytes, prefixLength]` pair compared against a parsed address. */
type Cidr = [Uint8Array, number];

/**
 * Parse a `address/prefix` literal into a {@link Cidr}.
 *
 * Throws on a missing or out-of-range prefix. Without that check a bare
 * address would yield `NaN`, and every `inCidr` test against it would pass,
 * silently turning one blocklist entry into "block everything".
 *
 * @internal exported for tests.
 */
export function cidr(literal: string): Cidr {
  const parts = literal.split("/");
  if (parts.length !== 2) {
    throw new Error(`CIDR literal must be address/prefix: ${literal}`);
  }
  const ip = parseIpLiteral(parts[0]);
  if (!ip) {
    throw new Error(`Invalid CIDR address: ${literal}`);
  }
  // `Number("")` is 0 and `Number("abc")` is NaN; both would produce a range
  // that matches every address, so the digits are checked before conversion.
  if (!/^(0|[1-9]\d{0,2})$/.test(parts[1])) {
    throw new Error(`Invalid CIDR prefix length: ${literal}`);
  }
  const prefixLength = Number(parts[1]);
  // A zero-length prefix matches everything and is never a real blocklist
  // entry, so it is refused alongside an out-of-range one.
  if (prefixLength < 1 || prefixLength > ip.bytes.length * 8) {
    throw new Error(`Invalid CIDR prefix length: ${literal}`);
  }
  return [ip.bytes, prefixLength];
}

function inCidr(bytes: Uint8Array, [prefixBytes, prefixLength]: Cidr): boolean {
  if (bytes.length !== prefixBytes.length) return false;
  const wholeBytes = prefixLength >> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (bytes[i] !== prefixBytes[i]) return false;
  }
  const remainingBits = prefixLength & 7;
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits);
  return (bytes[wholeBytes] & mask) === (prefixBytes[wholeBytes] & mask);
}

/**
 * Parse a dotted-quad IPv4 literal. Rejects leading zeros, so only the
 * canonical spelling parses here.
 *
 * For the special schemes this policy allows, the WHATWG URL parser has
 * already canonicalized the alternate numeric forms (`2130706433`, `127.1`,
 * `0x7f000001`) to dotted-quad by the time a hostname reaches this code. A
 * non-special scheme would keep the original spelling, which is why the
 * decision rests on the resolved-address check rather than on this parse.
 */
function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Parse an IPv6 literal, returning `null` for anything malformed. */
function parseIpv6(text: string): Uint8Array | null {
  const withoutZone = text.split("%")[0];
  if (withoutZone.length === 0) return null;

  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;
  const hasElision = halves.length === 2;

  const readGroups = (chunk: string): number[] | null => {
    if (chunk.length === 0) return [];
    const groups: number[] = [];
    for (const group of chunk.split(":")) {
      if (group.includes(".")) {
        // Trailing dotted-quad form, e.g. `::ffff:127.0.0.1`.
        const quad = parseIpv4(group);
        if (!quad) return null;
        groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  // A dotted quad may only appear as the last group of the whole address, so
  // it has to be in the final half and at the end of it.
  const lastHalf = hasElision ? halves[1] : halves[0];
  const dotted = withoutZone.indexOf(".");
  if (dotted !== -1) {
    if (halves[0].includes(".") && hasElision) return null;
    const lastGroup = lastHalf.slice(lastHalf.lastIndexOf(":") + 1);
    if (!lastGroup.includes(".")) return null;
    if (withoutZone.indexOf(":", dotted) !== -1) return null;
  }

  const head = readGroups(halves[0]);
  const tail = hasElision ? readGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  const total = head.length + tail.length;
  if (hasElision ? total > 7 : total !== 8) return null;

  const bytes = new Uint8Array(16);
  head.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  tail.forEach((group, i) => {
    const offset = 16 - (tail.length - i) * 2;
    bytes[offset] = group >> 8;
    bytes[offset + 1] = group & 0xff;
  });
  return bytes;
}

function parseIpLiteral(text: string): IpAddress | null {
  const bare =
    text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const v4 = parseIpv4(bare);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIpv6(bare);
  if (v6) return { version: 6, bytes: v6 };
  return null;
}

// IPv4 ranges that are not globally routable (RFC 6890 special-purpose
// registry): this-network, private, carrier-grade NAT, loopback, link-local,
// IETF assignments, documentation, benchmarking, 6to4 relay anycast, multicast
// and reserved.
const BLOCKED_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(cidr);

// Everything outside global unicast is non-global, which covers the
// unspecified address, loopback, unique-local `fc00::/7`, link-local
// `fe80::/10`, multicast `ff00::/8` and the reserved blocks. The ranges below
// sit inside global unicast but are still not routable to a public host.
const IPV6_GLOBAL_UNICAST = cidr("2000::/3");
const BLOCKED_IPV6 = [
  "2001::/23", // IETF protocol assignments, including Teredo and benchmarking
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4, which embeds an arbitrary IPv4 destination
  "3ffe::/16", // 6bone, returned to the reserved pool
  "3fff::/20", // documentation (RFC 9637)
].map(cidr);

// Blocked whatever the policy says. Link-local carries the cloud metadata
// services, and the individual addresses below are metadata endpoints outside
// it. None is ever a legitimate source of URL content.
const ALWAYS_BLOCKED_IPV4 = [
  cidr("0.0.0.0/8"), // this-network is never a legitimate URL destination
  cidr("169.254.0.0/16"), // link-local, including 169.254.169.254 and 169.254.170.2
  cidr("100.100.100.200/32"), // Alibaba Cloud metadata
  cidr("192.0.0.192/32"), // Oracle Cloud metadata
  cidr("168.63.129.16/32"), // Azure WireServer
];
const ALWAYS_BLOCKED_IPV6 = [
  cidr("fe80::/10"), // link-local
  cidr("fd00:ec2::254/128"), // AWS IPv6 instance metadata
  // NAT64 translation addresses are never a public content host, and the
  // embedded-address layout for a /48 prefix is split around a reserved octet
  // (RFC 6052), so the range is refused outright rather than decoded.
  // Teredo carries the client IPv4 in its low 32 bits, obfuscated by XOR, so
  // the range is refused outright rather than decoded.
  cidr("2001::/32"),
];

// IPv6 prefixes that carry an IPv4 address inside them. Each entry gives the
// prefix and the byte offset of the embedded address, so a blocked IPv4 target
// cannot be smuggled through one of these IPv6 spellings. Prefixes whose
// layout is not a plain byte range (Teredo) or which a site chooses for itself
// (RFC 6052 network-specific) are refused by range instead.
const IPV4_MAPPED_PREFIX = cidr("::ffff:0:0/96");

/**
 * Prefixes that carry an IPv4 address at a fixed byte offset, independent of
 * any NAT64 configuration.
 */
const IPV4_EMBEDDING_PREFIXES: { prefix: Cidr; offset: number }[] = [
  { prefix: IPV4_MAPPED_PREFIX, offset: 12 }, // IPv4-mapped
  { prefix: cidr("::ffff:0:0:0/96"), offset: 12 }, // IPv4-translated (SIIT)
  { prefix: cidr("::/96"), offset: 12 }, // IPv4-compatible (deprecated)
  { prefix: cidr("2002::/16"), offset: 2 }, // 6to4
];

/**
 * Byte positions of the embedded IPv4 address for each RFC 6052 prefix length.
 *
 * The address is split around the reserved octet at byte 8, which is why this
 * is a list of ranges rather than one offset.
 */
const NAT64_LAYOUTS: Record<number, [number, number][]> = {
  32: [[4, 8]],
  40: [
    [5, 8],
    [9, 10],
  ],
  48: [
    [6, 8],
    [9, 11],
  ],
  56: [
    [7, 8],
    [9, 12],
  ],
  64: [[9, 13]],
  96: [[12, 16]],
};

/** Pull the IPv4 address a NAT64 address carries, per RFC 6052 section 2.2. */
function embeddedNat64Address(
  ip: IpAddress,
  prefixLength: number,
): IpAddress | null {
  const ranges = NAT64_LAYOUTS[prefixLength];
  if (!ranges) return null;
  const bytes = new Uint8Array(4);
  let written = 0;
  for (const [start, end] of ranges) {
    for (let i = start; i < end && written < 4; i++) {
      bytes[written++] = ip.bytes[i];
    }
  }
  if (written !== 4) return null;
  return { version: 4, bytes };
}

/** Parse the configured NAT64 prefixes, always including the well-known one. */
function nat64Prefixes(policy: UrlFetchPolicy): { prefix: Cidr }[] {
  const literals = new Set<string>([
    WELL_KNOWN_NAT64_PREFIX,
    LOCAL_USE_NAT64_PREFIX,
    ...(policy.nat64Prefixes ?? []),
  ]);
  return [...literals].map((literal) => ({ prefix: cidr(literal) }));
}

/**
 * Every address that has to be checked for `ip`: any IPv4 address embedded in
 * it by an IPv6 transition prefix, then the address itself.
 *
 * Embedded addresses come first so that a refusal names the actual target
 * rather than the IPv6 wrapper carrying it.
 */
function addressesToCheck(
  ip: IpAddress,
  policy: UrlFetchPolicy = DEFAULT_URL_FETCH_POLICY,
): IpAddress[] {
  if (ip.version !== 6) return [ip];
  const embedded: IpAddress[] = [];
  for (const { prefix } of nat64Prefixes(policy)) {
    if (!inCidr(ip.bytes, prefix)) continue;
    const translated = embeddedNat64Address(ip, prefix[1]);
    if (translated) embedded.push(translated);
  }
  for (const { prefix, offset } of IPV4_EMBEDDING_PREFIXES) {
    if (!inCidr(ip.bytes, prefix)) continue;
    const bytes = ip.bytes.slice(offset, offset + 4);
    // A candidate in 0.0.0.0/8 is never a real embedded target: `::/96`
    // matches `::` and `::1`, and reporting `::1` as "0.0.0.1" would be
    // misleading. 0.0.0.0/8 is refused on its own account anyway, so the
    // candidate is dropped for any prefix and the address itself carries the
    // decision.
    if (bytes[0] === 0) continue;
    embedded.push({ version: 4, bytes });
  }
  return [...embedded, ip];
}

function isAlwaysBlocked(ip: IpAddress): boolean {
  const ranges = ip.version === 4 ? ALWAYS_BLOCKED_IPV4 : ALWAYS_BLOCKED_IPV6;
  return ranges.some((range) => inCidr(ip.bytes, range));
}

function isNonGlobal(ip: IpAddress): boolean {
  if (ip.version === 4) {
    return BLOCKED_IPV4.some((range) => inCidr(ip.bytes, range));
  }
  return (
    !inCidr(ip.bytes, IPV6_GLOBAL_UNICAST) ||
    BLOCKED_IPV6.some((range) => inCidr(ip.bytes, range))
  );
}

/**
 * Return the address that must not be reached server-side, or `null` when
 * every address derived from `address` is acceptable.
 */
function blockedAddress(
  address: IpAddress,
  allowPrivateNetworks = false,
  policy: UrlFetchPolicy = DEFAULT_URL_FETCH_POLICY,
): IpAddress | null {
  // A recognised NAT64 address is a wrapper around an IPv4 destination, and
  // the prefix itself sits outside global unicast. Judging the wrapper on its
  // own shape would refuse every translated address, including a perfectly
  // public one, so the embedded address carries the decision instead.
  const wrapperIsNat64 = isNat64(address, policy);
  for (const ip of addressesToCheck(address, policy)) {
    // This-network, cloud metadata and other link-local services are never
    // legitimate URL content sources, even when an application opts into its
    // private network.
    if (isAlwaysBlocked(ip)) return ip;
    if (wrapperIsNat64 && ip === address) continue;
    if (!allowPrivateNetworks && isNonGlobal(ip)) return ip;
  }
  return null;
}

/** True when `ip` sits under a NAT64 prefix this policy recognises. */
function isNat64(ip: IpAddress, policy: UrlFetchPolicy): boolean {
  return (
    ip.version === 6 &&
    nat64Prefixes(policy).some(
      ({ prefix }) =>
        inCidr(ip.bytes, prefix) &&
        embeddedNat64Address(ip, prefix[1]) !== null,
    )
  );
}

// `node:dns` is loaded on demand rather than imported at the top of the module.
// `src/index.ts` keeps server-only dependencies off the main entry so
// client-side bundlers can trace it, and a static import here would put a Node
// builtin back into that graph.
let dnsModule: typeof import("node:dns") | undefined;

async function loadDns(): Promise<typeof import("node:dns")> {
  dnsModule ??= await import("node:dns");
  return dnsModule;
}

/**
 * Reject if `promise` outlives `deadlineAt`.
 *
 * The `AbortSignal` in `fetchUrlBytes` only reaches `fetch`, so a name lookup
 * that never returns would otherwise sit outside the policy timeout, once per
 * redirect hop.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number | undefined,
  what: string,
): Promise<T> {
  if (deadlineAt === undefined) return await promise;
  // Always raced, never short-circuited. An already-elapsed deadline still goes
  // through `Promise.race` so that `promise`, which the caller already started,
  // is subscribed. Abandoning it would leave a later rejection unowned, and an
  // unhandled rejection terminates the process.
  const remaining = Math.max(0, deadlineAt - now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new UrlFetchUnavailableError(
                `${what} exceeded the request deadline`,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve `host` to IP addresses, accepting IP literals as-is. */
async function resolvedAddresses(
  host: string,
  deadlineAt?: number,
): Promise<IpAddress[]> {
  const literal = parseIpLiteral(host);
  if (literal) return [literal];

  let records: { address: string }[];
  try {
    // Inside the try so a runtime without `node:dns` is classified as an
    // inability to resolve rather than surfacing as an opaque failure.
    const dns = await loadDns();
    records = await withDeadline(
      dns.promises.lookup(host, { all: true, verbatim: true }),
      deadlineAt,
      `Resolving host '${host}'`,
    );
  } catch (e) {
    // Only a genuine resolver failure is relabelled. The policy arm matters if
    // a future change raises one from inside the lookup; without it, such an
    // error would be reported as a resolution failure.
    if (
      e instanceof UrlFetchUnavailableError ||
      e instanceof UrlFetchPolicyError
    ) {
      throw e;
    }
    throw new UrlFetchUnavailableError(
      `cannot resolve host: ${e instanceof Error ? e.name : "error"}`,
    );
  }
  if (records.length === 0) {
    throw new UrlFetchUnavailableError("host resolves to no IP address");
  }
  const addresses: IpAddress[] = [];
  for (const record of records) {
    const parsed = parseIpLiteral(record.address);
    // Refuse rather than skip: an address that cannot be parsed cannot be
    // checked, and skipping it would let it through unvalidated.
    if (!parsed) {
      throw new UrlFetchUnavailableError(
        "host resolved to an address that cannot be parsed",
      );
    }
    addresses.push(parsed);
  }
  return addresses;
}

/**
 * Validate `url` against `policy`.
 *
 * Throws {@link UrlFetchPolicyError} if the URL is refused on its merits,
 * {@link UrlFetchUnavailableError} if it cannot be evaluated (unparseable, or
 * a host that will not resolve), and a plain `Error` if `policy` itself is
 * unusable, which is a programming error rather than a fetch outcome.
 *
 * @internal not part of the package's public API; exported for tests.
 */
export async function validateFetchUrl(
  url: string,
  policy: UrlFetchPolicy = DEFAULT_URL_FETCH_POLICY,
  deadlineAt?: number,
): Promise<IpAddress[]> {
  assertUsablePolicy(policy);
  await loadCrypto();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlFetchUnavailableError("URL is malformed");
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!policy.allowedSchemes.has(scheme)) {
    throw new UrlFetchPolicyError(
      `URL scheme '${scheme}' is not allowed (allowed: ${JSON.stringify(
        [...policy.allowedSchemes].sort(),
      )})`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new UrlFetchPolicyError(
      "URL carries credentials in its userinfo, which fetch refuses to send",
    );
  }
  const host = parsed.hostname;
  if (!host) {
    // Unreachable while the allowlist is confined to http/https, both of which
    // require an authority. Kept so a future scheme cannot slip through
    // unchecked.
    throw new UrlFetchPolicyError(
      `URL with scheme '${scheme}' has no host to check`,
    );
  }
  const approved = await resolvedAddresses(host, deadlineAt);
  for (const address of approved) {
    const blocked = blockedAddress(
      address,
      policy.allowPrivateNetworks,
      policy,
    );
    if (blocked) {
      // `blocked` is the address that actually matched, which for an IPv6
      // transition form is the IPv4 address embedded in it.
      const reported = formatAddress(blocked);
      const via =
        blocked === address ? "" : ` (embedded in ${formatAddress(address)})`;
      throw new UrlFetchPolicyError(
        `resolves to non-public address ${reported}${via}, ` +
          "which is blocked by the URL fetch policy",
      );
    }
  }
  return approved;
}

function formatAddress(ip: IpAddress): string {
  if (ip.version === 4) return Array.from(ip.bytes).join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((ip.bytes[i] << 8) | ip.bytes[i + 1]).toString(16));
  }
  return groups.join(":");
}

/** The largest delay `setTimeout` accepts without silently clamping to 1ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Reject a policy whose limits cannot express a meaningful decision.
 *
 * Throws a plain `Error`: an unusable policy is a programming or
 * configuration mistake, not a fetch outcome, so it is deliberately not one
 * of the two errors {@link fetchUrlContent} turns into a logged `null`.
 *
 * `fetchUrlContent` calls this itself, which is enough to fail closed but
 * fails once per attachment and, on the history-replay path, inside a
 * try/catch that would report it as a conversion that fell back to text. The
 * adapter therefore calls this once up front, before the run fetches
 * anything, so a misconfigured policy surfaces as a run-level error naming
 * the field. Python has no equivalent call because its `UrlFetchPolicy` is a
 * frozen dataclass that validates in `__post_init__`; a TypeScript interface
 * has no constructor to validate in.
 *
 * @internal not part of the package's public API; exported for the adapter's
 * configuration check and for tests.
 */
export function assertUsablePolicy(policy: UrlFetchPolicy): void {
  if (!Number.isInteger(policy.maxBytes) || policy.maxBytes < 1) {
    throw new Error(
      `URL fetch policy maxBytes must be an integer of at least 1, got ${policy.maxBytes}`,
    );
  }
  // setTimeout silently clamps anything past a signed 32-bit millisecond count
  // to 1ms, which would abort every fetch immediately.
  if (
    !Number.isFinite(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `URL fetch policy timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}, got ${policy.timeoutMs}`,
    );
  }
  if (typeof policy.allowedSchemes?.has !== "function") {
    throw new Error("URL fetch policy allowedSchemes must provide has()");
  }
  // Only http and https are fetched through a transport pinned to the
  // addresses that passed validation. Allowing any other scheme would route
  // the request through a client that resolves the host again, which is the
  // rebinding window this policy exists to close.
  for (const scheme of policy.allowedSchemes) {
    if (scheme !== "http" && scheme !== "https") {
      throw new Error(
        `URL fetch policy allowedSchemes may only contain http and https, got '${forLog(scheme, 40)}'`,
      );
    }
  }
  // Read in truthiness position throughout, so a string "false" out of config
  // would otherwise open the private network.
  if (typeof policy.allowPrivateNetworks !== "boolean") {
    throw new Error("URL fetch policy allowPrivateNetworks must be a boolean");
  }
  if (!Number.isInteger(policy.maxRedirects) || policy.maxRedirects < 0) {
    throw new Error(
      `URL fetch policy maxRedirects must be a non-negative integer, got ${policy.maxRedirects}`,
    );
  }
}

// `node:http` and `node:https` are loaded on demand for the same reason as
// `node:dns`: src/index.ts keeps server-only dependencies off the main entry.
let httpModule: typeof import("node:http") | undefined;
let httpsModule: typeof import("node:https") | undefined;

async function loadHttp(secure: boolean) {
  if (secure) {
    httpsModule ??= await import("node:https");
    return httpsModule;
  }
  httpModule ??= await import("node:http");
  return httpModule;
}

/**
 * A `lookup` implementation that offers only the addresses validation approved.
 *
 * The hostname is still what the request carries, so the `Host` header, TLS SNI
 * and certificate verification all continue to see the real name; only the
 * address the socket dials is constrained.
 */
function pinnedLookup(approved: IpAddress[]) {
  const records = approved.map((ip) => ({
    address: formatAddress(ip),
    family: ip.version,
  }));
  return (
    _hostname: string,
    options: { all?: boolean; family?: number | string },
    callback: (
      err: Error | null,
      address?: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    // `family` arrives as 4 / 6, or as "IPv4" / "IPv6" from some callers.
    const wanted =
      typeof options?.family === "string"
        ? Number(options.family.replace(/^IPv/, ""))
        : options?.family;
    const usable = wanted
      ? records.filter((record) => record.family === wanted)
      : records;
    if (usable.length === 0) {
      callback(
        new UrlFetchPolicyError(
          "no validated address is available for this request",
        ),
      );
      return;
    }
    if (options?.all) {
      callback(null, usable);
      return;
    }
    callback(null, usable[0].address, usable[0].family);
  };
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Escape a literal `%` that does not begin a valid `%XX` escape.
 *
 * The URL parser already percent-encodes spaces and non-ASCII in the path and
 * query, so those need no help here, and it leaves existing escapes alone so a
 * presigned URL keeps the `%2F` and `%3D` its signature was computed over.
 * What it does not repair is a `%` from a name like `50%.txt`, which would go
 * on the wire as an invalid request target. Only `%` is rewritten, so the
 * result cannot grow an authority delimiter and the component stays within the
 * URL it came from.
 */
function escapeBarePercent(component: string): string {
  return component.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
}

/**
 * Perform one request, reaching only `approved`.
 *
 * A fresh agent with keep-alive disabled is used for every hop. A pooled socket
 * is keyed by host and port, not by the addresses that were approved for it, so
 * a reused connection would skip `lookup` entirely and could carry a request to
 * an address this policy never cleared.
 */
async function pinnedRequest(
  target: string,
  approved: IpAddress[],
  policy: UrlFetchPolicy,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(target);
  const secure = url.protocol === "https:";
  const mod = await loadHttp(secure);
  const agent = new mod.Agent({ keepAlive: false, maxSockets: 1 });

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      reject(
        error instanceof Error
          ? error
          : new UrlFetchUnavailableError("HTTP request failed"),
      );
    };
    const request = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        // Built from the components of the target validation just cleared, and
        // after that validation, so the repair cannot reach the host, the port
        // or the addresses `lookup` is pinned to.
        path: `${escapeBarePercent(url.pathname)}${escapeBarePercent(url.search)}`,
        method: "GET",
        lookup: pinnedLookup(approved) as never,
        agent,
        signal,
        // No proxy is consulted: these modules ignore the ambient proxy
        // environment, so the socket cannot be routed somewhere unvalidated.
      },
      (message) => {
        try {
          const status = message.statusCode;
          if (status === undefined || status < 200 || status > 599) {
            message.destroy();
            rejectOnce(
              new UrlFetchUnavailableError(
                status === undefined
                  ? "response carried no HTTP status"
                  : `response carried unsupported HTTP status ${status}`,
              ),
            );
            return;
          }

          const headers = new Headers();
          for (const [name, value] of Object.entries(message.headers)) {
            if (value === undefined) continue;
            for (const single of Array.isArray(value) ? value : [value]) {
              headers.append(name, single);
            }
          }

          let body: ReadableStream<Uint8Array> | null = null;
          if (NULL_BODY_STATUSES.has(status)) {
            message.resume();
          } else {
            body = new ReadableStream<Uint8Array>({
              start(controller) {
                let streamSettled = false;
                const errorStream = (error: unknown) => {
                  if (streamSettled) return;
                  streamSettled = true;
                  try {
                    controller.error(error);
                  } catch {
                    message.destroy();
                  }
                };
                message.on("data", (chunk: Buffer) => {
                  if (streamSettled) return;
                  try {
                    controller.enqueue(new Uint8Array(chunk));
                  } catch (error) {
                    errorStream(error);
                    message.destroy();
                  }
                });
                message.on("end", () => {
                  if (streamSettled) return;
                  streamSettled = true;
                  try {
                    controller.close();
                  } catch {
                    message.destroy();
                  }
                });
                message.on("error", errorStream);
                message.on("aborted", () =>
                  errorStream(
                    new UrlFetchUnavailableError("response body was aborted"),
                  ),
                );
              },
              cancel() {
                message.destroy();
              },
            });
          }

          resolveOnce(new Response(body, { status, headers }));
        } catch {
          message.destroy();
          rejectOnce(
            new UrlFetchUnavailableError(
              "HTTP response could not be represented safely",
            ),
          );
        }
      },
    );
    request.once("error", rejectOnce);
    request.once("upgrade", (_message, socket) => {
      socket.destroy();
      rejectOnce(
        new UrlFetchUnavailableError(
          "HTTP protocol upgrades are not supported",
        ),
      );
    });
    request.once("close", () => {
      if (!settled) {
        rejectOnce(
          new UrlFetchUnavailableError(
            "connection closed before an HTTP response was received",
          ),
        );
      }
    });
    request.setTimeout(policy.timeoutMs, () => {
      request.destroy(
        new UrlFetchUnavailableError(
          `no response within the ${policy.timeoutMs}ms request timeout`,
        ),
      );
    });
    request.end();
  });
}

/**
 * The transport boundary.
 *
 * @internal not part of the package's public API; exists so tests can stand in
 * for the socket layer.
 */
export const urlFetchTransport = { request: pinnedRequest };

/** Monotonic milliseconds, so a wall-clock step cannot move a deadline. */
function now(): number {
  return performance.now();
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Name the redirect hop that failed, when it is not the URL that was asked for. */
function hopSuffix(url: string, target: string): string {
  return target === url ? "" : ` (at redirect target ${describeUrl(target)})`;
}

/**
 * Release a response body this code is not going to read.
 *
 * Undici holds the socket until the body is consumed or cancelled, so a
 * redirect hop or an error response whose body is dropped on the floor leaks a
 * connection per fetch.
 */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A body that is already errored or closed needs no release.
  }
}

/** Read the response body, refusing anything past `maxBytes`. */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  // Advisory only: a server can understate or omit it, so the streaming check
  // below stays the authority. When it is present and already over the cap,
  // refusing here avoids transferring the body at all.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isInteger(declared) && declared > maxBytes) {
    await discardBody(res);
    throw new UrlFetchPolicyError(
      `response declares ${declared} bytes, over the ${maxBytes} byte limit`,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new UrlFetchPolicyError(
          `response exceeds the ${maxBytes} byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the oversized-body path; a stream that already
    // finished or errored needs no release, so a rejection here is expected.
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** A fetched body together with the content type the response declared. */
export interface FetchedContent {
  readonly bytes: Uint8Array;
  /** The response `Content-Type`, or `null` when the response omitted one. */
  readonly contentType: string | null;
}

/**
 * Fetch a URL's body and declared content type using the global fetch
 * (Node 20+).
 *
 * The URL is validated against `policy` before any request is made and again
 * on every redirect hop, so requests to private, loopback or cloud-metadata
 * addresses are refused, as are schemes outside the allowlist. The response
 * body is read in chunks and capped at `policy.maxBytes`.
 *
 * Returns `null` on any failure (policy violation, network error, timeout,
 * oversized body); the reason is logged. Throws only if `policy` itself is
 * unusable, which is a programming error rather than a fetch outcome.
 *
 * @internal not part of the package's public API; exported for tests.
 */
export async function fetchUrlContent(
  url: string,
  log: Logger,
  policy: UrlFetchPolicy = DEFAULT_URL_FETCH_POLICY,
  callerSignal?: AbortSignal,
): Promise<FetchedContent | null> {
  assertUsablePolicy(policy);
  // Loaded up front so every failure path below can name the URL opaquely.
  await loadCrypto();
  let refusedTarget = url;
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new UrlFetchUnavailableError(
          `fetch exceeded the ${policy.timeoutMs}ms request timeout`,
        ),
      ),
    policy.timeoutMs,
  );
  const deadlineAt = now() + policy.timeoutMs;
  // The caller's signal only ever aborts sooner; it grants no reach the
  // policy did not already allow.
  const onCallerAbort = () =>
    controller.abort(
      new UrlFetchUnavailableError("the caller abandoned the request"),
    );
  if (callerSignal?.aborted) onCallerAbort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    let target = url;
    for (let hop = 0; ; hop++) {
      // Tracked outside the try so the catch can name the hop that failed
      // rather than only the URL originally asked for.
      refusedTarget = target;
      // Checked per hop as well as inside the lookup, so a budget already spent
      // stops the chain deterministically rather than depending on whether the
      // next resolution happens to be instant.
      if (now() >= deadlineAt) {
        throw new UrlFetchUnavailableError("request deadline exceeded");
      }
      const approved = await validateFetchUrl(target, policy, deadlineAt);
      // Bound to the addresses just approved for this hop, and only those.
      const res = await urlFetchTransport.request(
        target,
        approved,
        policy,
        controller.signal,
      );
      if (res.type === "opaqueredirect") {
        // Node returns the real 3xx and its Location under
        // `redirect: "manual"`. A runtime that returns an opaque redirect
        // instead cannot be validated hop by hop, so the fetch is refused
        // rather than followed blind.
        await discardBody(res);
        throw new UrlFetchPolicyError(
          "redirect cannot be re-validated on this runtime, which returns " +
            'opaque redirects for `redirect: "manual"`',
        );
      }
      if (res.status === 0) {
        // Not a policy decision: a zero status on any other response type is a
        // transport failure.
        await discardBody(res);
        throw new UrlFetchUnavailableError(
          `response carried no HTTP status (type '${forLog(res.type)}')`,
        );
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await discardBody(res);
        if (!location) {
          log.warn(
            `${LOG_PREFIX} Failed to fetch URL ${describeUrl(url)}: HTTP ${res.status} without a Location header${hopSuffix(url, target)}`,
          );
          return null;
        }
        if (hop >= policy.maxRedirects) {
          throw new UrlFetchPolicyError(
            `more than ${policy.maxRedirects} redirects`,
          );
        }
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          throw new UrlFetchPolicyError(
            "redirect Location is not a usable URL",
          );
        }
        // A redirect must not quietly move the transfer onto cleartext.
        if (
          new URL(target).protocol === "https:" &&
          next.protocol === "http:"
        ) {
          throw new UrlFetchPolicyError(
            "redirect downgrades the transfer from https to http",
          );
        }
        target = next.toString();
        continue;
      }
      if (!res.ok) {
        await discardBody(res);
        log.warn(
          `${LOG_PREFIX} Failed to fetch URL ${describeUrl(url)}: HTTP ${res.status}${hopSuffix(url, target)}`,
        );
        return null;
      }
      return {
        bytes: await readBoundedBody(res, policy.maxBytes),
        contentType: res.headers.get("content-type"),
      };
    }
  } catch (e) {
    if (e instanceof UrlFetchPolicyError) {
      log.error(
        `${LOG_PREFIX} Refusing to fetch URL ${describeUrl(url)}: ${e.message}${hopSuffix(url, refusedTarget)}`,
      );
      return null;
    }
    if (e instanceof UrlFetchUnavailableError) {
      log.warn(
        `${LOG_PREFIX} Failed to fetch URL ${describeUrl(url)}: ${e.message}${hopSuffix(url, refusedTarget)}`,
      );
      return null;
    }
    // The raw error is not handed to the sink: a runtime message can quote the
    // URL it was given, including its userinfo and query.
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log.warn(
      `${LOG_PREFIX} Failed to fetch URL ${describeUrl(url)}: ${scrubSecrets(detail, refusedTarget, url)}${hopSuffix(url, refusedTarget)}`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * {@link fetchUrlContent} for callers that only need the body.
 *
 * @internal not part of the package's public API; exported for tests.
 */
export async function fetchUrlBytes(
  url: string,
  log: Logger,
  policy: UrlFetchPolicy = DEFAULT_URL_FETCH_POLICY,
): Promise<Uint8Array | null> {
  const fetched = await fetchUrlContent(url, log, policy);
  return fetched ? fetched.bytes : null;
}

function decodeBase64(
  value: string,
  log: Logger,
  where: string,
): Uint8Array | null {
  try {
    const bin = globalThis.atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch (e) {
    log.warn(`${LOG_PREFIX} Failed to decode base64 content (${where}):`, e);
    return null;
  }
}

/**
 * Per-request memo of what each URL returned, keyed by URL and policy.
 *
 * One conversation turn is converted more than once on a cold run: once
 * building the construction-time seed and again reconciling the replayed
 * history. Sharing one of these across those conversions is what keeps a
 * remote attachment to a single download per run instead of one per
 * conversion.
 *
 * Promises rather than values, so two conversions asking for the same URL at
 * the same time share the one request. Failures are memoised too: a URL the
 * policy refused stays refused for the rest of the run rather than being
 * retried per conversion.
 *
 * Entries are keyed on the URL together with the policy it is fetched under,
 * not the URL alone, so the memoised refusal above belongs to the policy that
 * made it and is never handed to a caller running under a different one.
 *
 * Every consumer of one URL receives the SAME `Uint8Array`, not a copy. That
 * is the point (the bytes are held once however many blocks reference them),
 * and it holds because content blocks treat their source bytes as read-only.
 * A consumer that needs to mutate them must copy first.
 *
 * A memoised fetch is bound to the signal of whichever caller started it. That
 * is sound because a cache and a cancellation signal both belong to one
 * request and are passed together: every caller sharing a cache shares the
 * signal that filled it. Pairing a cache with a different signal per call
 * would break that.
 */
export type UrlFetchCache = Map<string, Promise<FetchedContent | null>>;

/** Create a cache for one request. */
export function createUrlFetchCache(): UrlFetchCache {
  return new Map();
}

/**
 * What one request shares across every conversion it makes.
 *
 * `messageId` is the field that varies between the conversions of a single
 * request: it scopes document names to the message they came from, so two
 * messages carrying byte-identical documents still produce the distinct names
 * Bedrock requires.
 */
export interface MediaConversionOptions {
  /** Shared so one URL is fetched once per request, not once per conversion. */
  readonly fetchCache?: UrlFetchCache;
  /** The AG-UI id of the message this content belongs to. */
  readonly messageId?: string;
  /**
   * Aborts in-flight downloads when the caller goes away. Media resolution
   * runs long before the model does, so without this a client disconnect
   * leaves a slow attachment transferring until it finishes or times out.
   */
  readonly signal?: AbortSignal;
  /**
   * The policy every URL source in this request is fetched under.
   *
   * `undefined` means {@link DEFAULT_URL_FETCH_POLICY}. The adapter sets this
   * once per run from `StrandsAgentConfig.urlFetchPolicy`, so the construction
   * seed, the replayed history and the live turn all fetch under the same one.
   */
  readonly urlFetchPolicy?: UrlFetchPolicy;
}

/**
 * A cache key that cannot confuse two policies, or two URLs.
 *
 * Every field here changes what a fetch returns for the same URL, so all of
 * them are in the key. The refusals matter most: a URL a strict policy turned
 * away is memoised as `null`, and serving that to a caller who opted into the
 * private network would silently ignore the opt-in.
 *
 * `JSON.stringify` over one array, rather than a `${a}:${b}` join, because a
 * join has no delimiter a value cannot contain: a URL may hold any character,
 * including whatever separator was picked. The array's own structure keeps the
 * parts apart, and both lists are sorted so a policy spelled in a different
 * order is still the same policy. The `?? []` on the prefixes mirrors what
 * `nat64Prefixes` tolerates, so a policy this key accepts is one the checks
 * accept too.
 */
function fetchCacheKey(url: string, policy: UrlFetchPolicy): string {
  return JSON.stringify([
    url,
    [...policy.allowedSchemes].sort(),
    policy.allowPrivateNetworks,
    policy.maxBytes,
    policy.timeoutMs,
    policy.maxRedirects,
    [...(policy.nat64Prefixes ?? [])].sort(),
  ]);
}

function fetchUrlContentCached(
  url: string,
  log: Logger,
  options: MediaConversionOptions | undefined,
): Promise<FetchedContent | null> {
  const cache = options?.fetchCache;
  const signal = options?.signal;
  const policy = options?.urlFetchPolicy ?? DEFAULT_URL_FETCH_POLICY;
  if (!cache) {
    return fetchUrlContent(url, log, policy, signal);
  }
  // Checked before the key is built rather than only inside the fetch, so an
  // unusable policy cannot reach the iteration the key does over its fields
  // and surface as a bare TypeError instead of the sentence naming the field.
  assertUsablePolicy(policy);
  // Keyed on the URL AND the policy. One run passes one policy, so the
  // sharing this cache exists for is untouched: two conversions of the same
  // URL in a run still make one request. A caller that mixes policies over
  // one cache gets one entry per pair instead of the first policy's answer
  // for all of them.
  const key = fetchCacheKey(url, policy);
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchUrlContent(url, log, policy, signal);
    cache.set(key, pending);
  }
  return pending;
}

/** Resolve an AG-UI content source to bytes and whatever type it declared. */
async function resolveSource(
  source: InputContentSource,
  log: Logger,
  options: MediaConversionOptions | undefined,
  where: string,
): Promise<FetchedContent | null> {
  // `value` is typed as a string on both variants but arrives off the wire.
  // A non-string reaching `atob` is silently coerced and shipped as content;
  // one reaching the fetch throws from inside its own error handler, where
  // `describeUrl` hashes it. Both are refused here instead.
  if (typeof source.value !== "string") {
    log.warn(
      `${LOG_PREFIX} Content source (${where}) has no usable value, cannot resolve bytes`,
    );
    return null;
  }
  if (source.type === "data") {
    const bytes = decodeBase64(source.value, log, where);
    return bytes ? { bytes, contentType: null } : null;
  }
  if (source.type === "url") {
    return await fetchUrlContentCached(source.value, log, options);
  }
  log.warn(
    `${LOG_PREFIX} Unknown content source type (${where}): ${forLog((source as { type?: string }).type)}, cannot resolve bytes`,
  );
  return null;
}

/** A media item that could not be turned into a ContentBlock, and why. */
export interface DroppedMedia {
  /**
   * The AG-UI content type of the item that was dropped. Bounded and stripped
   * of control characters like every other client-supplied value that leaves
   * this module, because an unknown type is whatever the client sent.
   */
  readonly type: string;
  /** A short, non-sensitive reason, safe to put on the wire. */
  readonly reason: string;
}

/** What one conversion produced, including what it could not convert. */
export interface MediaConversionResult {
  readonly blocks: ContentBlock[];
  /**
   * Media items the conversion could not deliver. Empty on a clean
   * conversion, so a caller can tell a partial delivery from a message that
   * carried no attachments at all.
   *
   * Every conversion reports its own drops. Which of those reach the wire is
   * the adapter's decision, and it reports only the live turn's: re-announcing
   * a drop from an earlier turn on every replay of the thread would say
   * nothing new.
   */
  readonly dropped: DroppedMedia[];
}

const IMAGE_TOP_LEVEL: ReadonlySet<string> = new Set(["image"]);
const VIDEO_TOP_LEVEL: ReadonlySet<string> = new Set(["video"]);
// Documents legitimately arrive as either, e.g. application/pdf and text/csv.
const DOCUMENT_TOP_LEVEL: ReadonlySet<string> = new Set([
  "application",
  "text",
]);

const DROP_UNSUPPORTED_TYPE = "unsupported media type";
const DROP_UNRESOLVABLE = "content could not be resolved";
// Kept apart from DROP_UNRESOLVABLE: a caller can fix a malformed item, and
// cannot fix a remote host that would not answer.
const DROP_MALFORMED = "content item is malformed";
const DROP_EMPTY = "content was empty";
// Kept distinct from DROP_UNSUPPORTED_TYPE: a caller can fix a missing type by
// declaring one, and cannot fix a type this adapter does not carry.
const DROP_UNTYPED = "no media type declared or returned";

/**
 * Resolve one media item to the format string and bytes a ContentBlock needs.
 *
 * The declared type is checked before anything is fetched or decoded, so an
 * attachment that could never be delivered costs no egress. A URL source that
 * declares no type is the one case that has to be fetched first: the
 * response's own content type is then the only thing left to read it from.
 */
async function resolveMedia(
  source: InputContentSource,
  allowed: Set<string>,
  topLevel: ReadonlySet<string>,
  log: Logger,
  options: MediaConversionOptions | undefined,
  where: string,
): Promise<{ bytes: Uint8Array; format: string } | { drop: string }> {
  // Typed as present, but it arrives off the wire. A malformed item is
  // dropped like any other rather than throwing out of the conversion and
  // taking the message's other attachments with it.
  if (!source || typeof source !== "object") {
    log.warn(`${LOG_PREFIX} Skipping content (${where}): ${DROP_MALFORMED}`);
    return { drop: DROP_MALFORMED };
  }
  const declared =
    typeof source.mimeType === "string" ? source.mimeType : undefined;
  let format: string | null = null;
  if (declared) {
    format = mimeToFormat(declared, allowed, log, where);
    if (!format) return { drop: DROP_UNSUPPORTED_TYPE };
  }

  const resolved = await resolveSource(source, log, options, where);
  if (!resolved) {
    // resolveSource names this item on every path it refuses itself. Only a
    // fetch failure does not: that logs against the URL's digest, deeper down,
    // so it is the one case still missing a line naming the attachment.
    if (source.type === "url") {
      log.warn(
        `${LOG_PREFIX} Skipping content (${where}): ${DROP_UNRESOLVABLE}`,
      );
    }
    return { drop: DROP_UNRESOLVABLE };
  }
  if (resolved.bytes.length === 0) {
    // A zero-length array is truthy, so this needs its own check: an empty
    // block is not a smaller attachment, it is one the provider rejects for
    // the whole request.
    log.warn(
      `${LOG_PREFIX} Skipping content with an empty body (${where}): a zero-byte block is rejected by the provider`,
    );
    return { drop: DROP_EMPTY };
  }

  if (!format) {
    // Only reached when the source declared nothing, so this type is entirely
    // the remote server's word, and only this path is checked against the
    // family. A DECLARED `text/png` on an image is still accepted, because a
    // client naming its own attachment is not the case being defended
    // against. Requiring the top-level type to match the kind
    // of attachment asked for stops a server relabelling a payload across
    // families, e.g. serving `text/png` for an image, which the subtype check
    // below would accept on its own.
    //
    // It does NOT make an untyped document URL safe: an error page served as
    // `text/html` is a legitimate document type, and nothing in a 200 response
    // distinguishes it from the document that was asked for. Declaring a type
    // on the attachment is what avoids that.
    const served = resolved.contentType;
    if (!served) {
      log.warn(
        `${LOG_PREFIX} No MIME type provided by the source or the response (${where}), cannot determine format`,
      );
      return { drop: DROP_UNTYPED };
    }
    const parsedServed = parseMime(served);
    if (!parsedServed || !topLevel.has(parsedServed.topLevel)) {
      log.warn(
        `${LOG_PREFIX} Response type '${forLog(served)}' (${where}) is not one of ${JSON.stringify([...topLevel].sort())} for this attachment`,
      );
      return { drop: DROP_UNSUPPORTED_TYPE };
    }
    format = mimeToFormat(served, allowed, log, where, parsedServed);
    if (!format) return { drop: DROP_UNSUPPORTED_TYPE };
  }
  return { bytes: resolved.bytes, format };
}

/**
 * A Bedrock document name that is unique within a request and stable across
 * replays of the same content.
 *
 * Bedrock requires document names to be unique across the whole request, so a
 * fixed name makes any message carrying two documents unsendable. Three things
 * separate the names, and each is load-bearing:
 *
 *  - the message id, because one request converts each message separately, so
 *    a per-conversion counter alone would give byte-identical documents in two
 *    different messages the same name;
 *  - the index within that message, which separates byte-identical copies
 *    attached to the same message;
 *  - the content digest, which separates two different documents that land at
 *    the same index of the same message. Replay stability comes from the
 *    message id and the index, which are what stay the same across replays;
 *    the digest is what stops two different payloads colliding.
 *
 * The name is model-visible, so nothing user-controlled is copied into it; the
 * message id is hashed rather than interpolated.
 *
 * Close to the Python sibling's `_document_name` but not identical: Python
 * keys a URL-sourced document on the URL string, so its name survives the
 * remote content changing, while this keys on the bytes actually fetched, so a
 * changed remote yields a changed name. Both are unique within a request,
 * which is what the provider requires.
 */
function documentName(
  bytes: Uint8Array,
  index: number,
  messageId: string | undefined,
): string {
  // `loadCrypto()` is awaited before every call and throws rather than leaving
  // the module unset, so there is no unloaded case to fall back for.
  const hash = cryptoModule!.createHash("sha256");
  const utf8 = new TextEncoder();
  for (const part of [messageId ?? "direct", String(index)]) {
    const encoded = utf8.encode(part);
    // Length-prefixed so two different component splits cannot collide.
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, encoded.length);
    hash.update(length);
    hash.update(encoded);
  }
  hash.update(bytes);
  return `document-${hash.digest("hex").slice(0, 32)}`;
}

/**
 * Convert an AG-UI `InputContent` list to Strands `ContentBlock` values,
 * reporting what could not be converted.
 *
 * Supported types:
 *  - `TextInputContent` -> `TextBlock`
 *  - `ImageInputContent` -> `ImageBlock` (png, jpeg, gif, webp)
 *  - `DocumentInputContent` -> `DocumentBlock` (pdf, csv, doc, docx, xls, xlsx, html, txt, md)
 *  - `VideoInputContent` -> `VideoBlock` (flv, mkv, mov, mpeg, mpg, mp4, 3gp, webm, wmv)
 *  - `AudioInputContent`: skipped (Strands has no audio support).
 *  - Deprecated `binary` content: mapped to an `ImageBlock`, taking inline
 *    `data` when present and fetching `url` only when it is absent.
 *  - Unresolvable items (bad MIME, fetch failure, empty body): skipped and
 *    reported in `dropped`.
 *
 * A result carrying document blocks and no usable text block gains a leading
 * `TextBlock(" ")`, because Bedrock rejects the request otherwise.
 *
 * Pass the same `options.fetchCache` to every conversion made for one request
 * so a remote attachment is fetched once rather than once per conversion, and
 * `options.messageId` so document names stay unique across the request.
 *
 * @internal not part of the package's public API; `convertAguiContentToStrands`
 * is the exported entry point.
 */
export async function convertAguiContentToStrandsDetailed(
  content: InputContent[],
  log: Logger = DEFAULT_LOGGER,
  options?: MediaConversionOptions,
): Promise<MediaConversionResult> {
  const blocks: ContentBlock[] = [];
  const dropped: DroppedMedia[] = [];
  let documentIndex = 0;

  for (const [itemIndex, item] of content.entries()) {
    // Two dropped attachments in one conversion are otherwise
    // indistinguishable in the log.
    const where = `item ${itemIndex}${options?.messageId ? ` of message ${forLog(options.messageId)}` : ""}`;

    if (!item || typeof item !== "object") {
      // Logged but not reported, for the same reason a malformed text item is
      // not: `dropped` is the media report and reaches a client beside a count
      // of media delivered.
      log.warn(`${LOG_PREFIX} Skipping content (${where}): not an object`);
      continue;
    }

    // A bare `{ text }` with no discriminant is what the SDK's serialized
    // blocks look like, and `flattenContentToText` already reads them as text.
    // Falling through to the unknown-type branch reported one to the client as
    // a lost attachment.
    if (
      item.type === undefined &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const bare = (item as unknown as { text: string }).text;
      if (bare.length > 0) blocks.push(new TextBlock(bare));
      continue;
    }

    if (item.type === "text") {
      // `text` is typed as a string but arrives off the wire, so a malformed
      // item must be dropped like any other rather than throwing out of the
      // whole conversion and taking the other attachments with it. An empty
      // one is dropped too: the provider rejects an empty block on its own
      // account, and it carries nothing to lose.
      const text = (item as TextInputContent).text;
      if (typeof text === "string" && text.length > 0) {
        blocks.push(new TextBlock(text));
      } else if (typeof text !== "string") {
        // Logged but not reported: `dropped` is the media report, and it
        // reaches a client next to a count of media blocks delivered. A text
        // item in it would read as a lost attachment.
        log.warn(
          `${LOG_PREFIX} Skipping text (${where}): no usable text field`,
        );
      }
      continue;
    }

    if (item.type === "image") {
      const resolved = await resolveMedia(
        (item as ImageInputContent).source,
        IMAGE_FORMATS,
        IMAGE_TOP_LEVEL,
        log,
        options,
        where,
      );
      if ("drop" in resolved) {
        // resolveMedia has already logged the reason with this item's
        // context; a second line here would report one drop twice.
        dropped.push({ type: "image", reason: resolved.drop });
        continue;
      }
      blocks.push(
        new ImageBlock({
          format: resolved.format as ImageFormat,
          source: { bytes: resolved.bytes },
        }),
      );
      continue;
    }

    if (item.type === "document") {
      const index = documentIndex++;
      // Names the digest below. A failure here would otherwise throw out of
      // the whole conversion, which is the one outcome the drop-and-report
      // design exists to avoid, so this document is dropped instead.
      try {
        await loadCrypto();
      } catch (e) {
        log.warn(
          `${LOG_PREFIX} Skipping document (${where}): the hash used to name it is unavailable`,
          e,
        );
        dropped.push({ type: "document", reason: DROP_UNRESOLVABLE });
        continue;
      }
      const resolved = await resolveMedia(
        (item as DocumentInputContent).source,
        DOCUMENT_FORMATS,
        DOCUMENT_TOP_LEVEL,
        log,
        options,
        where,
      );
      if ("drop" in resolved) {
        // resolveMedia has already logged the reason with this item's
        // context; a second line here would report one drop twice.
        dropped.push({ type: "document", reason: resolved.drop });
        continue;
      }
      blocks.push(
        new DocumentBlock({
          format: resolved.format as DocumentFormat,
          name: documentName(resolved.bytes, index, options?.messageId),
          source: { bytes: resolved.bytes },
        }),
      );
      continue;
    }

    if (item.type === "video") {
      const resolved = await resolveMedia(
        (item as VideoInputContent).source,
        VIDEO_FORMATS,
        VIDEO_TOP_LEVEL,
        log,
        options,
        where,
      );
      if ("drop" in resolved) {
        // resolveMedia has already logged the reason with this item's
        // context; a second line here would report one drop twice.
        dropped.push({ type: "video", reason: resolved.drop });
        continue;
      }
      blocks.push(
        new VideoBlock({
          format: resolved.format as VideoFormat,
          source: { bytes: resolved.bytes },
        }),
      );
      continue;
    }

    if (item.type === "audio") {
      log.warn(
        `${LOG_PREFIX} Skipping audio (${where}): Strands has no audio support`,
      );
      dropped.push({ type: "audio", reason: "Strands has no audio support" });
      continue;
    }

    if ((item as { type: string }).type === "binary") {
      // Deprecated legacy binary content — try to map to an image block.
      const bin = item as {
        type: "binary";
        mimeType: string;
        url?: string;
        data?: string;
      };
      const fmt = mimeToFormat(
        typeof bin.mimeType === "string" ? bin.mimeType : undefined,
        IMAGE_FORMATS,
        log,
        where,
      );
      if (!fmt) {
        // mimeToFormat has already said why, with this item's context; a
        // second line here would log one dropped item twice.
        dropped.push({
          type: "binary",
          reason:
            typeof bin.mimeType === "string" && bin.mimeType
              ? DROP_UNSUPPORTED_TYPE
              : DROP_UNTYPED,
        });
        continue;
      }
      // `data` present but empty, or present and malformed, is a caller
      // sending nothing rather than a caller asking for the URL. Falling
      // through would spend a request the message never asked for and then
      // report the wrong reason, so any present `data` claims the item.
      const hasInlineData = bin.data !== undefined && bin.data !== null;
      let bytes: Uint8Array | null = null;
      let inlineMalformed = false;
      if (hasInlineData) {
        if (typeof bin.data !== "string") {
          inlineMalformed = true;
        } else if (bin.data) {
          bytes = decodeBase64(bin.data, log, where);
          if (!bytes) inlineMalformed = true;
        } else {
          bytes = new Uint8Array(0);
        }
      } else if (typeof bin.url === "string" && bin.url) {
        bytes =
          (await fetchUrlContentCached(bin.url, log, options))?.bytes ?? null;
      }
      if (inlineMalformed) {
        log.warn(`${LOG_PREFIX} Skipping binary (${where}): ${DROP_MALFORMED}`);
        dropped.push({ type: "binary", reason: DROP_MALFORMED });
        continue;
      }
      if (!bytes) {
        log.warn(
          `${LOG_PREFIX} Skipping binary (${where}): ${DROP_UNRESOLVABLE}`,
        );
        dropped.push({ type: "binary", reason: DROP_UNRESOLVABLE });
        continue;
      }
      if (bytes.length === 0) {
        log.warn(`${LOG_PREFIX} Skipping binary (${where}): ${DROP_EMPTY}`);
        dropped.push({ type: "binary", reason: DROP_EMPTY });
        continue;
      }
      blocks.push(
        new ImageBlock({ format: fmt as ImageFormat, source: { bytes } }),
      );
      continue;
    }

    log.warn(
      `${LOG_PREFIX} Skipping unknown content type (${where}): ${forLog((item as { type?: string }).type)}`,
    );
    dropped.push({
      type: forLog((item as { type?: string }).type, 40),
      reason: "unknown content type",
    });
  }

  // Bedrock rejects a message that carries document blocks but no text block,
  // which makes a document-only message unsendable on the live turn and on
  // every replay of the thread afterwards. The Python sibling inserts the same
  // single space.
  if (
    blocks.some((b) => b instanceof DocumentBlock) &&
    !blocks.some((b) => b instanceof TextBlock)
  ) {
    blocks.unshift(new TextBlock(" "));
  }

  return { blocks, dropped };
}

/**
 * Convert an AG-UI `InputContent` list to Strands `ContentBlock` values.
 *
 * See {@link convertAguiContentToStrandsDetailed}, which additionally reports
 * the items it could not convert.
 */
export async function convertAguiContentToStrands(
  content: InputContent[],
  log: Logger = DEFAULT_LOGGER,
  options?: MediaConversionOptions,
): Promise<ContentBlock[]> {
  return (await convertAguiContentToStrandsDetailed(content, log, options))
    .blocks;
}

/** Extract plain text from AG-UI message content or Strands content blocks. */
export function flattenContentToText(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const typed = item as { type?: string; text?: unknown };
      if (typeof typed.text !== "string") continue;
      // Three shapes carry text: AG-UI `TextInputContent` (`type: "text"`), a
      // Strands `TextBlock` instance (`type: "textBlock"`), and the SDK's
      // SERIALIZED block, which is a bare `{ text }` with no discriminant at
      // all. `_buildStrandsHistory` emits that third form, so omitting it made
      // a replayed turn flatten to nothing.
      if (
        typed.type === undefined ||
        typed.type === "text" ||
        typed.type === "textBlock"
      ) {
        parts.push(typed.text);
      }
    }
    return parts.join(" ");
  }
  // A single block rather than a list: same rules, one element.
  if (typeof content === "object") {
    return flattenContentToText([content]);
  }
  return "";
}

/** Best-effort string view of an AG-UI message content field. */
export function _coerceText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) return flattenContentToText(content);
  return String(content);
}

/**
 * Build a Strands `toolResult` content block from an AG-UI tool message body.
 *
 * AG-UI's wire shape requires `ToolMessage.content` to be a string. Frontends
 * (e.g. CopilotKit's `useHumanInTheLoop`) typically JSON-encode structured
 * results before transport, so the string the adapter receives looks like
 * `'{"accepted":true,"steps":[...]}'`. Forwarding that as a `text` block leaves
 * the LLM with two competing payloads: the original `toolUse.input` (full
 * args) and an opaque-looking JSON string in the result. The model often
 * defaults to the args.
 *
 * Strands' `ToolResultContentData` accepts a `JsonBlock` shape (see
 * `@strands-agents/sdk` `messages.ts`). When the message content parses as a
 * JSON object/array, emit it as `{ json: parsed }` so the LLM sees a real
 * structured result. Fall back to `{ text: ... }` for everything else.
 */
export function _buildToolResultContent(
  content: unknown,
): { text: string } | { json: unknown } {
  const text = _coerceText(content);
  const trimmed = text.trim();
  // Render-only frontend tools (e.g. CopilotKit `useComponent`) legitimately
  // produce an empty client tool result. Forwarding an empty `text` block to
  // the Strands model reaches OpenAI, which rejects tool messages with empty
  // content (HTTP 400). Synthesize a non-empty acknowledgement instead. The
  // Python adapter has no equivalent synthesis on either its history or its
  // reconciliation path, so it still forwards the empty block; that divergence
  // is deliberate here rather than drift. The UI-bound TOOL_CALL_RESULT event is
  // emitted on a separate path and stays faithfully empty.
  if (trimmed.length === 0)
    return { text: "Tool executed successfully with no return value." };
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return { text };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return { json: parsed };
    }
  } catch {
    // Not valid JSON, so fall through to text.
  }
  return { text };
}
