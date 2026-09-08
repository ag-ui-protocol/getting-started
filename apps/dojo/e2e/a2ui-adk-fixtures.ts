/**
 * aimock fixtures for the Google ADK A2UI demos (OSS-158).
 *
 * These emulate what the ADK adapter sees from a REAL Gemini sub-agent under the
 * free-form tool schema: `render_a2ui` returns `components`/`data` as JSON
 * *strings* (not structured arrays/objects), because Gemini's function-calling
 * fills typed `array<object>` args strictly (empty `{}`), so the ADK adapter
 * declares them as STRING and parses them back via `_coerce_freeform_args`.
 * Encoding them as strings here drives that real code path — in contrast to the
 * LangGraph/gpt-4o fixtures (a2ui-recovery-fixtures.ts), which use structured
 * arrays the way OpenAI fills loose schemas.
 *
 * Scoped to Gemini requests (`req.model` ~ "gemini-*") so they never intercept
 * the OpenAI LangGraph demos. Register BEFORE registerA2UIRecoveryFixtures so a
 * Gemini request matches here first; gpt-4o requests fall through.
 *
 * Covers: a2ui_fixed_schema (backend search_flights / search_hotels tools that
 * return a fixed-layout surface), a2ui_dynamic_schema (valid hotel surface) and
 * a2ui_recovery (recover: invalid→valid; exhaust: always invalid).
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
    return content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text!).join("");
  }
  return "";
};
const allText = (messages: ChatMessage[] = []): string => messages.map((m) => textOf(m.content)).join("\n");
const userText = (messages: ChatMessage[] = []): string =>
  textOf(messages.filter((m) => m.role === "user").pop()?.content);

// Toolkit appends this on a retry (augment_prompt_with_validation_errors).
const RETRY_MARKER = "Previous attempt was invalid";

const isGemini = (req: ChatCompletionRequest) => /gemini/i.test(String(req?.model ?? ""));
const isRecover = (text: string) => /luxury/i.test(text) && !/different cities/i.test(text);
const isExhaust = (text: string) => /broken/i.test(text);
// dynamic_schema hotel prompt ("...comparison of 3 hotels...") — not luxury/broken.
const isHotelCreate = (text: string) => /comparison of 3 hotels/i.test(text);

const ROOT = { id: "root", component: "Row", children: { componentId: "card", path: "/items" }, gap: 16 };
const CARD = {
  id: "card",
  component: "HotelCard",
  name: { path: "name" },
  location: { path: "location" },
  rating: { path: "rating" },
  pricePerNight: { path: "price" },
  action: { event: { name: "book_hotel", context: { hotelName: { path: "name" } } } },
};
const HOTELS = [
  { name: "The Ritz", location: "Paris", rating: 4.8, price: "$450/night" },
  { name: "Holiday Inn", location: "Austin", rating: 4.1, price: "$180/night" },
  { name: "Boutique Loft", location: "Lisbon", rating: 4.6, price: "$320/night" },
];

// Gemini free-form shape: components/data are JSON STRINGS within the args.
// valid → [root, card]; invalid → [root] only (root's child ref `card` is missing).
const renderArgsGemini = (valid: boolean) =>
  JSON.stringify({
    surfaceId: "hotel-comparison",
    components: JSON.stringify(valid ? [ROOT, CARD] : [ROOT]),
    data: JSON.stringify({ items: HOTELS }),
  });

// --- fixed_schema (backend tools) ---------------------------------------
// The main agent calls search_flights / search_hotels directly (no sub-agent).
// These are plain backend tools: the LLM supplies the row data, the ADK tool
// loads the fixed component layout and returns the a2ui_operations envelope.
// Args are structured here (flat arrays of flat objects) — Gemini fills these
// fine, unlike the nested array<object> of the dynamic render_a2ui schema.
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
    statusIcon: "https://placehold.co/12/22c55e/22c55e.png",
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
    statusIcon: "https://placehold.co/12/22c55e/22c55e.png",
    price: "$315",
  },
];
const HOTELS_FIXED = [
  { id: "1", name: "The Manhattan Grand", location: "Downtown Manhattan", rating: 4.5, price: "$350" },
  { id: "2", name: "Downtown Boutique Hotel", location: "SoHo", rating: 4.0, price: "$280" },
];

/**
 * Gemini tool-call ids must be supplied explicitly. aimock's Gemini serializer
 * used to fall back to a generated id (`id: tc.id || generateToolCallId()`); that
 * fallback was dropped before 1.23.1, which emitted no id at all, and 1.24.1
 * restored emission but only for an id the fixture supplies. With no
 * id, ADK's `populate_client_function_call_id()` mints a fresh UUID per SSE
 * event, so partial and final events disagree — the failure that
 * `_extract_lro_id_remap` works around, and only for LRO calls.
 */
const toolCallCounts = new Map<string, number>();
const geminiToolCall = (name: string, args: string) => () => {
  const n = (toolCallCounts.get(name) ?? 0) + 1;
  toolCallCounts.set(name, n);
  return { toolCalls: [{ name, arguments: args, id: `call_${name}_${n}` }] };
};

export function registerA2UIADKFixtures(mockServer: LLMock): void {
  // Reset per registration: the counter is module-level, so without this the
  // suffix would depend on test order, sharding and retries rather than on the
  // conversation.
  toolCallCounts.clear();
  const hasTool = (req: ChatCompletionRequest, name: string) => req.tools?.some((t: ToolDefinition) => t.function.name === name);
  const wantsA2UI = (req: ChatCompletionRequest) =>
    isHotelCreate(userText(req.messages)) || isRecover(userText(req.messages)) || isExhaust(userText(req.messages));

  // 0) fixed_schema — backend search_flights tool (user asks about flights).
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isGemini(req) && hasTool(req, "search_flights") && /flights/i.test(userText(req.messages)),
    },
    response: geminiToolCall("search_flights", JSON.stringify({ flights: FLIGHTS })),
  });

  // 0b) fixed_schema — backend search_hotels tool (user asks about hotels).
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isGemini(req) && hasTool(req, "search_hotels") && /hotels/i.test(userText(req.messages)),
    },
    response: geminiToolCall("search_hotels", JSON.stringify({ hotels: HOTELS_FIXED })),
  });

  // 1) Main ADK agent: A2UI prompt → call the generate_a2ui sub-agent tool.
  mockServer.addFixture({
    match: { predicate: (req: ChatCompletionRequest) => isGemini(req) && hasTool(req, "generate_a2ui") && wantsA2UI(req) },
    response: geminiToolCall("generate_a2ui", JSON.stringify({ intent: "create" })),
  });

  // 2) Sub-agent — dynamic_schema create → valid surface (Gemini-shaped args).
  mockServer.addFixture({
    match: { predicate: (req: ChatCompletionRequest) => isGemini(req) && hasTool(req, "render_a2ui") && isHotelCreate(allText(req.messages)) },
    response: geminiToolCall("render_a2ui", renderArgsGemini(true)),
  });

  // 3) Sub-agent — EXHAUST ("broken"): always the dangling-ref surface (invalid).
  mockServer.addFixture({
    match: { predicate: (req: ChatCompletionRequest) => isGemini(req) && hasTool(req, "render_a2ui") && isExhaust(allText(req.messages)) },
    response: geminiToolCall("render_a2ui", renderArgsGemini(false)),
  });

  // 4) Sub-agent — RECOVER ("luxury"), RETRY (errors fed back) → valid.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isGemini(req) && hasTool(req, "render_a2ui") && isRecover(allText(req.messages)) && allText(req.messages).includes(RETRY_MARKER),
    },
    response: geminiToolCall("render_a2ui", renderArgsGemini(true)),
  });

  // 5) Sub-agent — RECOVER ("luxury"), FIRST attempt (no marker) → invalid.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        isGemini(req) && hasTool(req, "render_a2ui") && isRecover(allText(req.messages)) && !allText(req.messages).includes(RETRY_MARKER),
    },
    response: geminiToolCall("render_a2ui", renderArgsGemini(false)),
  });
}
