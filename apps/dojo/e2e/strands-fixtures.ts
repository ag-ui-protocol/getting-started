/**
 * aimock fixtures for the AWS Strands interrupt, predictive-state and citations
 * demos.
 *
 * The interrupt and predictive-state flows make more than one model call per
 * user turn, and the responses differ by where in the flow the call happens
 * rather than by the user's text, so they need predicates rather than the
 * `userMessage` entries in fixtures/openai/*.json. The citations demo needs a
 * predicate for a different reason: its answers carry `citations`, and only
 * this demo's turns may.
 *
 * Every predicate is scoped to a phrase unique to the Strands demo's own system
 * prompt, so these never intercept another framework's demo (Mastra drives a
 * tool of the same name through the same dojo page, and the LangGraph
 * predictive-state demo drives a differently named one).
 *
 * Register via `registerStrandsFixtures(mockServer)` from aimock-setup.ts,
 * before the generic fixture-file loader.
 */
import type {
  LLMock,
  ChatMessage,
  ChatCompletionRequest,
} from "@copilotkit/aimock";

const textOf = (content: ChatMessage["content"] | undefined): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("");
  }
  return "";
};

const systemText = (messages: ChatMessage[] = []): string =>
  messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");

/**
 * The tool results belonging to THIS turn: the trailing run of them.
 *
 * Not the whole history, because an acceptance from turn one would otherwise
 * still be visible on a turn the user rejected. Not the final message either,
 * because one turn can deliver several results and the one being looked for
 * need not be last.
 */
const currentTurnToolResults = (messages: ChatMessage[] = []): string[] => {
  const batch: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "tool") break;
    batch.push(textOf(messages[i]?.content));
  }
  return batch;
};

/**
 * True when the confirm dialog answered `write_document` with a rejection.
 *
 * The result is JSON the dojo page produced, so it is parsed rather than
 * pattern-matched: a regex over the raw text would also match a document whose
 * own prose happened to contain the key, and would break on whitespace or key
 * ordering the page is free to change.
 */
const wasEditRejected = (messages: ChatMessage[] = []): boolean =>
  currentTurnToolResults(messages).some((raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { accepted?: unknown }).accepted === false
      );
    } catch {
      return false;
    }
  });

/**
 * True when the model is being called to react to a tool result rather than to
 * a new user turn. `some(role === "tool")` would not do: by the second user
 * turn the history already carries the first turn's tool result.
 */
const awaitingToolReaction = (messages: ChatMessage[] = []): boolean =>
  messages[messages.length - 1]?.role === "tool";

const lastUserText = (messages: ChatMessage[] = []): string =>
  textOf(messages.filter((m) => m.role === "user").pop()?.content);

/**
 * The user's own words from the last user turn, with any state the demo's
 * `state_context_builder` prepended stripped off.
 *
 * Matching the raw prompt would be wrong once a document exists: the builder
 * injects the CURRENT document ahead of the request, so a second turn asking to
 * rename Atlantis still contains "Atlantis" and would match the first-draft
 * fixture. The marker is the builder's own separator.
 */
const userRequestText = (messages: ChatMessage[] = []): string => {
  const raw = lastUserText(messages);
  const marker = "User request:";
  const at = raw.lastIndexOf(marker);
  return at === -1 ? raw : raw.slice(at + marker.length);
};

// ---------------------------------------------------------------------------
// Interrupt: `schedule_meeting` is a backend tool that pauses ITSELF, by calling
// the tool context's `interrupt()`. Two model calls bracket the pause: the one
// that proposes the call, and the one that reacts to the tool's result once the
// user has picked a time or cancelled.
// ---------------------------------------------------------------------------

/**
 * Scoped on a line only the Strands demo's prompt carries. Mastra's interrupt
 * demo drives a tool of the same name through the same page, so matching on the
 * tool name would claim its turns too.
 */
const IS_STRANDS_INTERRUPT = (req: ChatCompletionRequest) =>
  /Never claim a meeting is scheduled unless the tool result says so/i.test(
    systemText(req.messages),
  );

/**
 * What the paused tool returned once resumed, or "".
 *
 * The tool composes this itself out of the label the user clicked, so it is the
 * only place the chosen time is visible to the model.
 */
const scheduleResult = (messages: ChatMessage[] = []): string =>
  currentTurnToolResults(messages)[0] ?? "";

// ---------------------------------------------------------------------------
// Predictive state: `write_document` is a FRONTEND tool, so the model proposes
// the call, the browser renders the confirm dialog, and the tool result comes
// back on the next run. Documents are byte-identical to the LangGraph
// predictive-state fixtures so the shared spec assertions hold either way.
// ---------------------------------------------------------------------------

const IS_STRANDS_PREDICTIVE_STATE = (req: ChatCompletionRequest) =>
  /reserved for showing the user a diff/i.test(systemText(req.messages));

const ATLANTIS_DOCUMENT =
  "Once upon a time, in a land far away, there lived a magnificent dragon named Atlantis. Atlantis was known throughout the realm for its shimmering scales that reflected the light of a thousand stars. The dragon Atlantis would soar above the mountains, breathing fire that lit up the night sky. Villagers would gather to watch Atlantis perform its aerial dances, marveling at the grace of this ancient creature.";

const LOLA_DOCUMENT = ATLANTIS_DOCUMENT.replace(/Atlantis/g, "Lola");

/**
 * Characters per streamed chunk, so the ~400-character document arrives as many
 * incremental argument deltas rather than one buffered blob. That is what the
 * predict-state mapping projects from, and the spec asserts the delta count, so
 * a coarser value would make the feature untestable.
 */
const DOCUMENT_CHUNK_SIZE = 25;

/**
 * The reply for a Strands tool-result turn, or `null` if this file has none.
 *
 * Both the fixtures below and the veto in aimock-setup.ts read this one
 * function, which is what keeps them in step. When the veto was defined
 * separately it suppressed the generic acknowledgment for turns that no fixture
 * here answered, and those turns then fell through to the universal catch-all.
 */
function strandsToolResultReply(req: ChatCompletionRequest): string | null {
  if (!awaitingToolReaction(req.messages)) return null;

  if (IS_STRANDS_INTERRUPT(req)) {
    const result = scheduleResult(req.messages);
    // Reading the tool's own words rather than restating them: the chosen time
    // only exists in the result, so a canned reply could not carry it and a spec
    // could not tell a resumed run from a fabricated one.
    const scheduled = /^Meeting scheduled for (.+): /.exec(result);
    if (scheduled) {
      return `Your meeting is scheduled for ${scheduled[1]}. Looking forward to it!`;
    }
    if (/cancelled/i.test(result)) {
      return "No problem, I did not schedule anything. Tell me what you would like instead.";
    }
    return "I have left your calendar untouched. Tell me what you would like instead.";
  }

  if (IS_STRANDS_PREDICTIVE_STATE(req)) {
    return wasEditRejected(req.messages)
      ? "Understood, I discarded that edit and left the document as it was."
      : "I updated the document as requested.";
  }

  return null;
}

/** True for a tool-result turn this file answers itself. */
export function strandsAnswersToolResultTurn(
  req: ChatCompletionRequest,
): boolean {
  return strandsToolResultReply(req) !== null;
}

// ---------------------------------------------------------------------------
// Citations: the demo asks a research agent to answer over web sources, and the
// adapter folds what the model cites onto the message it annotates. aimock
// replays those as `url_citation` annotations on the Responses API, which is
// the one shape both Strands bridges map to a citation.
// ---------------------------------------------------------------------------

const IS_STRANDS_CITATIONS = (req: ChatCompletionRequest) =>
  /grounding what you say in what you find/i.test(systemText(req.messages));

/**
 * A citation whose offsets are derived from where `quote` sits in `content`.
 *
 * The end offset is also where aimock emits the annotation, so deriving it from
 * the quote puts each citation on the wire at the point the text it cites has
 * streamed, the way the real API does. Writing the numbers out by hand would
 * decouple them from the answer and silently drift the moment either is edited.
 */
const citing = (
  content: string,
  quote: string,
  url: string,
  title: string,
): {
  url: string;
  title: string;
  citedText: string;
  startIndex: number;
  endIndex: number;
} => {
  const at = content.indexOf(quote);
  if (at === -1) {
    throw new Error(`citation quote is not in the answer it cites: ${quote}`);
  }
  return {
    url,
    title,
    citedText: quote,
    startIndex: at,
    endIndex: at + quote.length,
  };
};

/** One cited answer: the text, plus the sources it is grounded in. */
const citedAnswer = (
  content: string,
  sources: [quote: string, url: string, title: string][],
) => ({
  content,
  citations: sources.map(([quote, url, title]) =>
    citing(content, quote, url, title),
  ),
});

const HTTP3_VS_HTTP2 = citedAnswer(
  "HTTP/3 runs over QUIC instead of TCP, so one lost packet no longer stalls " +
    "every other stream sharing the connection. It also folds the TLS " +
    "handshake into the transport handshake, which removes a round trip from " +
    "connection setup that HTTP/2 over TLS still pays.",
  [
    [
      "HTTP/3 runs over QUIC instead of TCP",
      "https://developer.mozilla.org/en-US/docs/Glossary/HTTP_3",
      "HTTP/3 - MDN Web Docs Glossary",
    ],
    [
      "folds the TLS handshake into the transport handshake",
      "https://www.rfc-editor.org/rfc/rfc9114.html",
      "RFC 9114: HTTP/3",
    ],
  ],
);

const WHAT_IS_HTTP3 = citedAnswer(
  "HTTP/3 is the third major version of HTTP, carried over QUIC rather than " +
    "TCP. It keeps the semantics of HTTP/2 and changes the transport " +
    "underneath, which is where its latency and head-of-line-blocking wins " +
    "come from.",
  [
    [
      "the third major version of HTTP",
      "https://www.rfc-editor.org/rfc/rfc9114.html",
      "RFC 9114: HTTP/3",
    ],
    [
      "keeps the semantics of HTTP/2",
      "https://developer.mozilla.org/en-US/docs/Glossary/HTTP_3",
      "HTTP/3 - MDN Web Docs Glossary",
    ],
  ],
);

const WHAT_IS_QUIC = citedAnswer(
  "QUIC is a transport protocol built on UDP that provides multiplexed " +
    "streams with TLS 1.3 built in. Because each stream is independent, a " +
    "packet lost on one does not block delivery on the others.",
  [
    [
      "a transport protocol built on UDP",
      "https://www.rfc-editor.org/rfc/rfc9000.html",
      "RFC 9000: QUIC",
    ],
    [
      "each stream is independent",
      "https://developer.mozilla.org/en-US/docs/Glossary/QUIC",
      "QUIC - MDN Web Docs Glossary",
    ],
  ],
);

const JAMES_WEBB = citedAnswer(
  "Webb observes on a schedule set by its approved programmes, which cover " +
    "targets from planets in our own solar system to the earliest galaxies. " +
    "The current programme list and observing plan are published by the " +
    "institute that operates the telescope.",
  [
    [
      "a schedule set by its approved programmes",
      "https://www.stsci.edu/jwst/science-execution/observing-schedules",
      "JWST Observing Schedules",
    ],
    [
      "the earliest galaxies",
      "https://science.nasa.gov/mission/webb/",
      "NASA: James Webb Space Telescope",
    ],
  ],
);

/**
 * The answer for a citations-demo turn.
 *
 * Every turn in this demo gets a cited answer, including one this file does not
 * recognise: an uncited fallback would leave a human clicking around the demo
 * looking at the empty state and reading it as the feature being broken.
 */
function strandsCitationsAnswer(req: ChatCompletionRequest) {
  const asked = lastUserText(req.messages);
  if (/differ/i.test(asked) && /HTTP\/2/i.test(asked)) return HTTP3_VS_HTTP2;
  if (/HTTP\/3/i.test(asked)) return WHAT_IS_HTTP3;
  if (/QUIC/i.test(asked)) return WHAT_IS_QUIC;
  if (/webb/i.test(asked)) return JAMES_WEBB;
  return WHAT_IS_HTTP3;
}

export function registerStrandsFixtures(mockServer: LLMock): void {
  // Citations. One fixture for the whole demo: which answer comes back is the
  // question the request asks, not which fixture matched, so the routing lives
  // in one function rather than spread across near-identical registrations
  // whose ordering would then be load-bearing.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: IS_STRANDS_CITATIONS,
    },
    response: (req) => strandsCitationsAnswer(req),
  });

  // The page's second suggestion pill. Registered ahead of the default booking
  // below so clicking it proposes the meeting it actually names.
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        IS_STRANDS_INTERRUPT(req) &&
        !awaitingToolReaction(req.messages) &&
        /1:1 with Alice/i.test(lastUserText(req.messages)),
    },
    response: {
      toolCalls: [
        {
          name: "schedule_meeting",
          arguments: JSON.stringify({
            topic: "1:1 to review Q2 goals",
            attendee: "Alice",
          }),
          id: "call_schedule_meeting_alice",
        },
      ],
    },
  });

  // Propose the meeting. No tool result yet means the pause has not happened.
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        IS_STRANDS_INTERRUPT(req) && !awaitingToolReaction(req.messages),
    },
    response: {
      toolCalls: [
        {
          name: "schedule_meeting",
          arguments: JSON.stringify({
            topic: "Intro call to discuss pricing",
            attendee: "the sales team",
          }),
          id: "call_schedule_meeting_1",
        },
      ],
    },
  });

  // Every tool-result turn this file owns, answered from the one function the
  // veto in aimock-setup.ts also reads, so coverage and suppression cannot
  // disagree.
  mockServer.addFixture({
    // Scoped to the chat endpoint, matching how aimock-setup.ts scopes its own
    // predicate-plus-function fixture: this answers chat turns only and has
    // nothing to say about image, speech or transcription requests.
    match: {
      endpoint: "chat",
      predicate: (req) => strandsToolResultReply(req) !== null,
    },
    response: (req) => ({ content: strandsToolResultReply(req)! }),
  });

  // Write the first draft. Args stream into `state.document` via predictState.
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        IS_STRANDS_PREDICTIVE_STATE(req) &&
        !awaitingToolReaction(req.messages) &&
        // Both names guarded: a request naming the new dragon wants the EDIT,
        // and this fixture is registered first, so an unguarded match here
        // would re-serve the first draft instead.
        /Atlantis/i.test(userRequestText(req.messages)) &&
        !/Lola/i.test(userRequestText(req.messages)),
    },
    // Small chunks so the arguments stream, which is the behaviour the
    // predict-state mapping exists for. One buffered blob would leave the
    // browser nothing to project.
    chunkSize: DOCUMENT_CHUNK_SIZE,
    response: {
      toolCalls: [
        {
          name: "write_document",
          arguments: JSON.stringify({ document: ATLANTIS_DOCUMENT }),
          id: "call_write_document_1",
        },
      ],
    },
  });

  // Rename the dragon. The current document arrives via stateContextBuilder.
  mockServer.addFixture({
    match: {
      predicate: (req) =>
        IS_STRANDS_PREDICTIVE_STATE(req) &&
        !awaitingToolReaction(req.messages) &&
        /Lola/i.test(userRequestText(req.messages)),
    },
    chunkSize: DOCUMENT_CHUNK_SIZE,
    response: {
      toolCalls: [
        {
          name: "write_document",
          arguments: JSON.stringify({ document: LOLA_DOCUMENT }),
          id: "call_write_document_2",
        },
      ],
    },
  });
}
