/**
 * aimock fixtures for the CrewAI A2UI demos.
 *
 * The CrewAI flows run openai/gpt-5.4 via litellm, so these are structured-arg
 * fixtures (like the LangGraph ones), not the Gemini JSON-string shape. Every
 * predicate is scoped
 * to a phrase unique to the CrewAI e2e prompts ("boutique hotels" for dynamic,
 * "search for flights" / "search for hotels" for fixed) so they never intercept
 * the LangGraph / ADK / Strands / Mastra demos (which use "comparison of 3
 * hotels" and "Find flights" / "Find hotels"). The recovery demo reuses the
 * shared a2ui-recovery-fixtures.ts ("luxury" / "broken").
 *
 * Register via `registerA2UICrewAIFixtures(mockServer)` from aimock-setup.ts.
 */
import type {
  LLMock,
  ChatMessage,
  ChatCompletionRequest,
  ToolDefinition,
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
const allText = (messages: ChatMessage[] = []): string =>
  messages.map((m) => textOf(m.content)).join("\n");
const userText = (messages: ChatMessage[] = []): string =>
  textOf(messages.filter((m) => m.role === "user").pop()?.content);
const lastMessage = (messages: ChatMessage[] = []): ChatMessage | undefined =>
  messages[messages.length - 1];

// ---------------------------------------------------------------------------
// Framework scope
//
// The three prompts the CrewAI A2UI e2e specs type. Every predicate below is
// gated on one of them, so nothing in this file can answer another
// integration's A2UI demo (they prompt with "Find flights" / "Find hotels" /
// "a comparison of 3 hotels") even though they register the same tool names.
// The last user message survives a surface-action run unchanged (the action is
// forwarded as tool messages, not as a new user turn), so the same gate scopes
// the action turns too.
// ---------------------------------------------------------------------------
const isFixedFlightPrompt = (text: string) => /search for flights/i.test(text);
const isFixedHotelPrompt = (text: string) => /search for hotels/i.test(text);
const isDynamicPrompt = (text: string) => /boutique hotels/i.test(text);
const isFixedRun = (req: { messages?: ChatMessage[] }) => {
  const text = userText(req.messages);
  return isFixedFlightPrompt(text) || isFixedHotelPrompt(text);
};
const isDynamicRun = (req: { messages?: ChatMessage[] }) =>
  isDynamicPrompt(userText(req.messages));
const isCrewAIA2UIRun = (req: { messages?: ChatMessage[] }) =>
  isFixedRun(req) || isDynamicRun(req);

// ---------------------------------------------------------------------------
// Surface actions
// ---------------------------------------------------------------------------

/** The tool-result line the A2UI middleware synthesizes for a surface action. */
const ACTION_REPORT =
  /^User performed action "([^"]*)" on surface "([^"]*)"(?: \(component: ([^)]*)\))?\. Context: ([\s\S]*)$/;

interface SurfaceAction {
  name: string;
  surfaceId: string;
  context: Record<string, unknown>;
}

const parseActionReport = (text: string): SurfaceAction | null => {
  const parts = ACTION_REPORT.exec(text.trim());
  if (!parts) return null;
  let context: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(parts[4]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      context = parsed as Record<string, unknown>;
    } else {
      console.warn(
        `[a2ui-crewai-fixtures] action "${parts[1]}" forwarded a non-object context; ` +
          `answering generically: ${parts[4]}`,
      );
    }
  } catch {
    // Still an action, so answer it without the detail rather than falling
    // through to another fixture. Logged because a context that stops parsing
    // is a real forwarding regression, and the only other symptom is a vaguer
    // reply that the spec's assertion would blame on the wrong thing.
    console.warn(
      `[a2ui-crewai-fixtures] action "${parts[1]}" forwarded an unparseable context; ` +
        `answering generically: ${parts[4]}`,
    );
  }
  return { name: parts[1], surfaceId: parts[2], context };
};

/**
 * The action a request is being asked to answer, read off the LAST message.
 *
 * Anchoring on the last message rather than the first report in the history is
 * what keeps a second click answering the SECOND choice: the history of a
 * repeat-click run carries every earlier report too.
 */
const pendingAction = (req: {
  messages?: ChatMessage[];
}): SurfaceAction | null => {
  const last = lastMessage(req.messages);
  if (!last || last.role !== "tool") return null;
  return parseActionReport(textOf(last.content));
};

const asText = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;

/**
 * The reply to a surface action, derived from the forwarded action context.
 *
 * Derived, never canned: a hard-coded item name would let the spec pass even if
 * the click of a different card were forwarded, or the wrong tool answered.
 */
const actionReply = (action: SurfaceAction | null): string => {
  const context = action?.context ?? {};
  const price = asText(context.price) ?? asText(context.pricePerNight);
  if (action?.name === "book_flight") {
    const flight = asText(context.flightNumber) ?? "your flight";
    const origin = asText(context.origin);
    const destination = asText(context.destination);
    const route =
      origin && destination ? ` from ${origin} to ${destination}` : "";
    return `You are booked on ${flight}${route}${
      price ? ` for ${price}` : ""
    }. Your itinerary is on its way.`;
  }
  const hotel = asText(context.hotelName) ?? asText(context.name);
  if (!hotel) return "You are booked. Your confirmation is on its way.";
  return `You are booked at ${hotel}${
    price ? ` for ${price} a night` : ""
  }. Your confirmation is on its way.`;
};

/** A CrewAI A2UI surface-action turn: the click report is the pending message. */
const isActionTurn = (req: { messages?: ChatMessage[] }) =>
  isCrewAIA2UIRun(req) && pendingAction(req) !== null;

/**
 * A CrewAI A2UI render follow-up turn: the flow looped the model over the
 * `a2ui_operations` envelope its own search / generation returned.
 */
const isRenderFollowUpTurn = (req: { messages?: ChatMessage[] }) => {
  const last = lastMessage(req.messages);
  return (
    isCrewAIA2UIRun(req) &&
    last?.role === "tool" &&
    /a2ui_operations/.test(textOf(last.content))
  );
};

/**
 * Whether a fixture in THIS file answers the request, for the generic
 * tool-result catch-all in aimock-setup.ts to step aside.
 *
 * Scoped to the CrewAI A2UI prompts on purpose: the replacements live here and
 * nowhere else, so an A2UI turn in any other integration must keep the generic
 * acknowledgment instead of dropping to the universal catch-all.
 */
export const crewAIA2UIAnswersToolResultTurn = (req: {
  messages?: ChatMessage[];
}): boolean => isActionTurn(req) || isRenderFollowUpTurn(req);

const ROOT = {
  id: "root",
  component: "Row",
  children: { componentId: "card", path: "/items" },
  gap: 16,
};
const CARD = {
  id: "card",
  component: "HotelCard",
  name: { path: "name" },
  location: { path: "location" },
  rating: { path: "rating" },
  pricePerNight: { path: "price" },
  action: {
    event: { name: "book_hotel", context: { hotelName: { path: "name" } } },
  },
};
const HOTELS = [
  { name: "The Ritz", location: "Paris", rating: 4.8, price: "$450/night" },
  { name: "Holiday Inn", location: "Austin", rating: 4.1, price: "$180/night" },
  {
    name: "Boutique Loft",
    location: "Lisbon",
    rating: 4.6,
    price: "$320/night",
  },
];
const renderArgs = JSON.stringify({
  surfaceId: "hotel-comparison",
  components: [ROOT, CARD],
  data: { items: HOTELS },
});

// Fixed-schema row data (matches the pre-authored flight/hotel layouts).
const FLIGHTS = [
  {
    id: "1",
    airline: "United Airlines",
    airlineLogo: "https://www.google.com/s2/favicons?domain=united.com&sz=128",
    flightNumber: "UA 123",
    origin: "SFO",
    destination: "JFK",
    date: "Tue, Apr 8",
    departureTime: "8:00 AM",
    arrivalTime: "4:30 PM",
    duration: "5h 30m",
    status: "On Time",
    price: "$289",
  },
  {
    id: "2",
    airline: "Delta",
    airlineLogo: "https://www.google.com/s2/favicons?domain=delta.com&sz=128",
    flightNumber: "DL 456",
    origin: "SFO",
    destination: "JFK",
    date: "Tue, Apr 8",
    departureTime: "10:00 AM",
    arrivalTime: "6:45 PM",
    duration: "5h 45m",
    status: "On Time",
    price: "$315",
  },
];
const HOTELS_FIXED = [
  {
    id: "1",
    name: "The Manhattan Grand",
    location: "Downtown Manhattan",
    rating: 4.5,
    price: "$350",
  },
  {
    id: "2",
    name: "Downtown Boutique Hotel",
    location: "SoHo",
    rating: 4.0,
    price: "$280",
  },
];

export function registerA2UICrewAIFixtures(mockServer: LLMock): void {
  const hasTool = (req: ChatCompletionRequest, name: string) =>
    req.tools?.some((t: ToolDefinition) => t.function.name === name);

  // Surface action, any demo: reply about the item that was actually clicked.
  // The reply comes from a response FACTORY reading the forwarded action
  // context, so the flight cards' "Select" is answered about that flight and a
  // second click is answered about the second choice.
  //
  // `endpoint: "chat"` is load-bearing for a FUNCTION response: it skips
  // aimock's per-endpoint response-shape gate, so without it this fixture
  // becomes eligible for image/speech/transcription requests.
  mockServer.addFixture({
    match: { endpoint: "chat", predicate: isActionTurn },
    response: (req: ChatCompletionRequest) => ({
      content: actionReply(pendingAction(req)),
    }),
  });

  // fixed_schema render follow-up: the closing reply the flow gets only by
  // looping the model over its own search result. Registered before the search
  // fixtures below so a request already carrying the envelope cannot re-search.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isRenderFollowUpTurn(req) && isFixedRun(req),
    },
    response: { content: "Here are your results." },
  });

  // dynamic_schema render follow-up: same closing turn, over the generate_a2ui
  // envelope. Must precede the generate_a2ui fixture for the same reason.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isRenderFollowUpTurn(req) && isDynamicRun(req),
    },
    response: { content: "Here is the comparison you asked for." },
  });

  // fixed_schema - backend search_flights tool ("search for flights").
  //
  // `hasToolResult: false` keeps the searches to the FIRST turn of a run: a
  // follow-up or action turn is answered by the fixtures above, never by
  // re-running the search (which would repaint the surface the user just
  // clicked). Deliberately no `content`, so the run's only assistant text is
  // the closing reply the loop produces.
  mockServer.addFixture({
    match: {
      hasToolResult: false,
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "search_flights") &&
        isFixedFlightPrompt(userText(req.messages)),
    },
    response: {
      toolCalls: [
        {
          name: "search_flights",
          arguments: JSON.stringify({ flights: FLIGHTS }),
        },
      ],
    },
  });

  // fixed_schema - backend search_hotels tool ("search for hotels").
  mockServer.addFixture({
    match: {
      hasToolResult: false,
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "search_hotels") &&
        isFixedHotelPrompt(userText(req.messages)),
    },
    response: {
      toolCalls: [
        {
          name: "search_hotels",
          arguments: JSON.stringify({ hotels: HOTELS_FIXED }),
        },
      ],
    },
  });

  // dynamic_schema - main agent calls the generate_a2ui sub-agent tool.
  mockServer.addFixture({
    match: {
      hasToolResult: false,
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "generate_a2ui") && isDynamicRun(req),
    },
    response: {
      toolCalls: [
        {
          name: "generate_a2ui",
          arguments: JSON.stringify({ intent: "create" }),
        },
      ],
    },
  });

  // dynamic_schema - sub-agent render_a2ui → valid hotel-comparison surface.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "render_a2ui") && isDynamicPrompt(allText(req.messages)),
    },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgs }] },
  });
}
