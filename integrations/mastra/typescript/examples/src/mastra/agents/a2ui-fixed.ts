import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Fixed-schema A2UI agent for Mastra (the direct-tool A2UI mode — the sibling of
 * the generate_a2ui/subagent path). The component layout is authored in code
 * (FLIGHT_SCHEMA / HOTEL_SCHEMA); the model only supplies the DATA. Each backend
 * tool returns a complete `a2ui_operations` envelope which the
 * `@ag-ui/a2ui-middleware` detects in the tool result and paints — no subagent,
 * no recovery, no auto-injection. Mirrors the LangGraph/Strands fixed-schema
 * demos; renders against the dojo fixedSchemaCatalog (fixed_catalog.json:
 * Row / FlightCard / HotelCard / StarRating).
 *
 * Return shape: the tool returns the envelope as an OBJECT (not a JSON string) so
 * the Mastra bridge single-encodes it onto the wire and the middleware intercepts
 * it (a bare string would be double-encoded and slip through as a plain result).
 */

const FIXED_CATALOG_ID = "https://a2ui.org/demos/dojo/fixed_catalog.json";
const A2UI_OPERATIONS_KEY = "a2ui_operations";

const FLIGHT_SURFACE_ID = "flight-search-results";
const FLIGHT_SCHEMA: Array<Record<string, unknown>> = [
  {
    id: "root",
    component: "Row",
    children: { componentId: "flight-card", path: "/flights" },
    gap: 16,
  },
  {
    id: "flight-card",
    component: "FlightCard",
    airline: { path: "airline" },
    airlineLogo: { path: "airlineLogo" },
    flightNumber: { path: "flightNumber" },
    origin: { path: "origin" },
    destination: { path: "destination" },
    date: { path: "date" },
    departureTime: { path: "departureTime" },
    arrivalTime: { path: "arrivalTime" },
    duration: { path: "duration" },
    status: { path: "status" },
    price: { path: "price" },
    action: {
      event: {
        name: "book_flight",
        context: {
          flightNumber: { path: "flightNumber" },
          origin: { path: "origin" },
          destination: { path: "destination" },
          price: { path: "price" },
        },
      },
    },
  },
];

const HOTEL_SURFACE_ID = "hotel-search-results";
const HOTEL_SCHEMA: Array<Record<string, unknown>> = [
  {
    id: "root",
    component: "Row",
    children: { componentId: "hotel-card", path: "/hotels" },
    gap: 16,
  },
  {
    id: "hotel-card",
    component: "HotelCard",
    name: { path: "name" },
    location: { path: "location" },
    rating: { path: "rating" },
    pricePerNight: { path: "price" },
    action: {
      event: {
        name: "book_hotel",
        context: {
          hotelName: { path: "name" },
          price: { path: "price" },
        },
      },
    },
  },
];

function renderOperations(
  surfaceId: string,
  schema: Array<Record<string, unknown>>,
  data: Record<string, unknown>,
): { a2ui_operations: Array<Record<string, unknown>> } {
  return {
    [A2UI_OPERATIONS_KEY]: [
      {
        version: "v0.9",
        createSurface: { surfaceId, catalogId: FIXED_CATALOG_ID },
      },
      { version: "v0.9", updateComponents: { surfaceId, components: schema } },
      {
        version: "v0.9",
        updateDataModel: { surfaceId, path: "/", value: data },
      },
    ],
  };
}

const searchFlightsTool = createTool({
  id: "search_flights",
  description:
    "Search for flights and display the results as rich cards. Each flight must " +
    "have: id, airline (e.g. 'United Airlines'), airlineLogo (Google favicon API " +
    "like 'https://www.google.com/s2/favicons?domain=united.com&sz=128'), " +
    "flightNumber, origin, destination, date (e.g. 'Tue, Mar 18'), departureTime, " +
    "arrivalTime, duration (e.g. '4h 25m'), status ('On Time' or 'Delayed'), and " +
    "price (e.g. '$289'). Generate 3-5 realistic results.",
  inputSchema: z.object({
    flights: z
      .array(z.record(z.string(), z.unknown()))
      .describe("Array of flight result objects."),
  }),
  execute: async ({ flights }) =>
    renderOperations(FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, { flights }),
});

const searchHotelsTool = createTool({
  id: "search_hotels",
  description:
    "Search for hotels and display the results as rich cards with star ratings. " +
    "Each hotel must have: id, name (e.g. 'The Plaza'), location " +
    "(e.g. 'Midtown Manhattan, NYC'), rating (float 0-5, e.g. 4.5), and price " +
    "(per night, e.g. '$350'). Generate 3-4 realistic results.",
  inputSchema: z.object({
    hotels: z
      .array(z.record(z.string(), z.unknown()))
      .describe("Array of hotel result objects."),
  }),
  execute: async ({ hotels }) =>
    renderOperations(HOTEL_SURFACE_ID, HOTEL_SCHEMA, { hotels }),
});

export const a2uiFixedSchemaAgent = new Agent({
  id: "a2ui_fixed_schema",
  name: "a2ui_fixed_schema",
  instructions: `You are a helpful travel assistant that can search for flights and hotels.

When the user asks about flights, use the search_flights tool.
When the user asks about hotels, use the search_hotels tool.
IMPORTANT: After calling a tool, do NOT repeat or summarize the data in your text response. The tool renders a rich UI automatically. Just say something brief like "Here are your results".

For flights, each needs: id, airline, airlineLogo (Google favicon API), flightNumber, origin, destination, date, departureTime, arrivalTime, duration, status, and price.
For hotels, each needs: id, name, location, rating (float 0-5), and price (per night).
Generate 3-5 realistic results.`,
  model: "openai/gpt-4.1",
  tools: { search_flights: searchFlightsTool, search_hotels: searchHotelsTool },
});
