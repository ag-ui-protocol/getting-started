/**
 * aimock fixtures for the A2UI recovery showcase (OSS-162).
 *
 * Forces a STRUCTURAL error (no catalog needed — caught by structural validation
 * in both the adapter loop and the middleware gate), so it rides the existing
 * runtime A2UI wiring with no schema:
 *   - "luxury hotels" demo → FIRST render_a2ui is a Row whose repeated child
 *     references a `card` component the model forgot to include ("unresolved
 *     child"); once the error is fed back, it emits a valid surface (recovery
 *     succeeds → no wipe, brief "Retrying…", final surface).
 *   - "broken hotels" demo → ALWAYS the dangling-reference surface → recovery
 *     exhausts → tasteful hard-failure (conversation stays usable).
 *
 * IMPORTANT: every predicate is scoped to the recovery demo's own prompts
 * ("luxury" / "broken"). The other A2UI demos (dynamic/fixed/advanced, incl.
 * fixed_schema's "Find hotels") must fall through to their generic fixtures —
 * an over-broad render_a2ui matcher here would hijack them and return THIS
 * surface, breaking every other A2UI test.
 *
 * Wire by calling `registerA2UIRecoveryFixtures(mockServer)` from aimock-setup.ts
 * BEFORE the generic fixture loader (predicate fixtures must come first).
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

// Marker the toolkit appends to the sub-agent prompt on retry
// (augmentPromptWithValidationErrors). Presence ⇒ this is a retry.
const RETRY_MARKER = "Previous attempt was invalid";

// Only THIS demo's prompts. Keep these distinct from the other A2UI demos so the
// fixtures below never intercept them.
//
// The dynamic_schema "Hotel comparison" prompt — "Compare 3 luxury hotels IN
// DIFFERENT CITIES with ratings and prices." — must SUCCEED with no retries, so
// `isRecover` requires "luxury" but EXCLUDES that "different cities" variant. The
// recovery demo's own prompt ("Compare 3 luxury hotels with ratings and prices.")
// has no "different cities", so only it triggers the recover-then-succeed flow;
// the dynamic_schema prompt falls through to its generic (valid) hotel fixture.
const isRecover = (text: string) => /luxury/i.test(text) && !/different cities/i.test(text);
const isExhaust = (text: string) => /broken/i.test(text); // "Compare 3 broken hotels…" → always invalid → exhaust

// A Row that repeats a "card" template over /items.
const ROOT = { id: "root", component: "Row", children: { componentId: "card", path: "/items" }, gap: 16 };
// The card template the root references. Omitting it from the components array is
// the structural error (dangling child reference → "unresolved child").
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
// valid → [root, card]; invalid → [root] only (root's child ref `card` is missing).
const renderArgs = (valid: boolean) =>
  JSON.stringify({ surfaceId: "hotel-comparison", components: valid ? [ROOT, CARD] : [ROOT], data: { items: HOTELS } });

export function registerA2UIRecoveryFixtures(mockServer: LLMock): void {
  const hasTool = (req: ChatCompletionRequest, name: string) => req.tools?.some((t: ToolDefinition) => t.function.name === name);

  // 1) Main agent: recovery prompt → call the generate_a2ui sub-agent tool.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "generate_a2ui") && (isRecover(userText(req.messages)) || isExhaust(userText(req.messages))),
    },
    response: { toolCalls: [{ name: "generate_a2ui", arguments: JSON.stringify({ intent: "create" }) }] },
  });

  // 2) Sub-agent — EXHAUSTION demo ("broken hotels"): always the dangling-ref surface.
  //    Checked before the recover fixtures so a "broken" retry stays invalid.
  mockServer.addFixture({
    match: { predicate: (req: ChatCompletionRequest) => hasTool(req, "render_a2ui") && isExhaust(allText(req.messages)) },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgs(false) }] },
  });

  // 3) Sub-agent — RECOVER demo ("luxury hotels"), RETRY (errors fed back) → valid.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "render_a2ui") && isRecover(allText(req.messages)) && allText(req.messages).includes(RETRY_MARKER),
    },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgs(true) }] },
  });

  // 4) Sub-agent — RECOVER demo ("luxury hotels"), FIRST attempt (no marker) → invalid.
  mockServer.addFixture({
    match: {
      predicate: (req: ChatCompletionRequest) =>
        hasTool(req, "render_a2ui") && isRecover(allText(req.messages)) && !allText(req.messages).includes(RETRY_MARKER),
    },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgs(false) }] },
  });
}
