/**
 * aimock fixtures for the AWS Strands interrupt and predictive-state demos.
 *
 * Both flows make more than one model call per user turn, and the responses
 * differ by where in the flow the call happens rather than by the user's text,
 * so they need predicates rather than the `userMessage` entries in
 * fixtures/openai/*.json.
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

export function registerStrandsFixtures(mockServer: LLMock): void {
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
