/**
 * aimock fixtures for the CrewAI A2UI demos.
 *
 * CrewAI runs gpt-4o via litellm, so these are structured-arg fixtures (like the
 * LangGraph ones), not the Gemini JSON-string shape. Every predicate is scoped
 * to a phrase unique to the CrewAI e2e prompts ("boutique hotels" for dynamic,
 * "search for flights" / "search for hotels" for fixed) so they never intercept
 * the LangGraph / ADK demos (which use "comparison of 3 hotels" and "Find
 * flights" / "Find hotels"). The recovery demo reuses the shared
 * a2ui-recovery-fixtures.ts ("luxury" / "broken").
 *
 * Register via `registerA2UICrewAIFixtures(mockServer)` from aimock-setup.ts.
 */
import type { LLMock, ChatMessage } from "@copilotkit/aimock";

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

const isDynamic = (text: string) => /boutique hotels/i.test(text);

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
  { name: "Boutique Loft", location: "Lisbon", rating: 4.6, price: "$320/night" },
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
  { id: "1", name: "The Manhattan Grand", location: "Downtown Manhattan", rating: 4.5, price: "$350" },
  { id: "2", name: "Downtown Boutique Hotel", location: "SoHo", rating: 4.0, price: "$280" },
];

export function registerA2UICrewAIFixtures(mockServer: LLMock): void {
  const hasTool = (req: any, name: string) =>
    req.tools?.some((t: any) => t.function.name === name);

  // fixed_schema - backend search_flights tool ("search for flights").
  mockServer.addFixture({
    match: {
      predicate: (req: any) =>
        hasTool(req, "search_flights") && /search for flights/i.test(userText(req.messages)),
    },
    response: {
      toolCalls: [{ name: "search_flights", arguments: JSON.stringify({ flights: FLIGHTS }) }],
    },
  });

  // fixed_schema - backend search_hotels tool ("search for hotels").
  mockServer.addFixture({
    match: {
      predicate: (req: any) =>
        hasTool(req, "search_hotels") && /search for hotels/i.test(userText(req.messages)),
    },
    response: {
      toolCalls: [{ name: "search_hotels", arguments: JSON.stringify({ hotels: HOTELS_FIXED }) }],
    },
  });

  // dynamic_schema - main agent calls the generate_a2ui sub-agent tool.
  mockServer.addFixture({
    match: {
      predicate: (req: any) => hasTool(req, "generate_a2ui") && isDynamic(userText(req.messages)),
    },
    response: {
      toolCalls: [{ name: "generate_a2ui", arguments: JSON.stringify({ intent: "create" }) }],
    },
  });

  // dynamic_schema - sub-agent render_a2ui → valid hotel-comparison surface.
  mockServer.addFixture({
    match: {
      predicate: (req: any) => hasTool(req, "render_a2ui") && isDynamic(allText(req.messages)),
    },
    response: { toolCalls: [{ name: "render_a2ui", arguments: renderArgs }] },
  });
}
