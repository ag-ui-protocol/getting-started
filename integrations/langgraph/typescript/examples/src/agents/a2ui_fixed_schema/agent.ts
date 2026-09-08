/**
 * Fixed-schema A2UI agent (prebuilt).
 *
 * Pre-built component layouts for flight and hotel cards. The agent only
 * supplies the data; layout/styling is fixed in code. Demonstrates the
 * "controlled gen-UI" pattern: author owns the UI shape, agent owns the data.
 */

import { createAgent } from "langchain";
import { copilotkitMiddleware } from "@copilotkit/sdk-js/langgraph";
import { tool } from "@langchain/core/tools";

const CUSTOM_CATALOG_ID =
  "https://a2ui.org/demos/dojo/fixed_catalog.json";

const A2UI_OPERATIONS_KEY = "a2ui_operations";

// Flight search layout — agent supplies `flights` array; rendering is fixed.
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

// Hotel search layout — agent supplies `hotels` array; rendering is fixed.
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
  catalogId: string,
  schema: Array<Record<string, unknown>>,
  data: Record<string, unknown>,
): string {
  const ops = [
    {
      version: "v0.9",
      createSurface: { surfaceId, catalogId },
    },
    {
      version: "v0.9",
      updateComponents: { surfaceId, components: schema },
    },
    {
      version: "v0.9",
      updateDataModel: { surfaceId, path: "/", value: data },
    },
  ];
  return JSON.stringify({ [A2UI_OPERATIONS_KEY]: ops });
}

const searchFlights = tool(
  async ({ flights }: { flights: Array<Record<string, unknown>> }) => {
    return renderOperations(
      FLIGHT_SURFACE_ID,
      CUSTOM_CATALOG_ID,
      FLIGHT_SCHEMA,
      { flights },
    );
  },
  {
    name: "search_flights",
    description:
      "Search for flights and display the results as rich cards. Each flight " +
      "must have: id, airline (e.g. 'United Airlines'), airlineLogo (use Google " +
      "favicon API like 'https://www.google.com/s2/favicons?domain=united.com&sz=128'), " +
      "flightNumber, origin, destination, date (e.g. 'Tue, Mar 18'), departureTime, " +
      "arrivalTime, duration (e.g. '4h 25m'), status ('On Time' or 'Delayed'), " +
      "and price (e.g. '$289').",
    schema: {
      type: "object",
      properties: {
        flights: {
          type: "array",
          items: { type: "object" },
          description: "Array of flight result objects.",
        },
      },
      required: ["flights"],
    } as any,
  },
);

const searchHotels = tool(
  async ({ hotels }: { hotels: Array<Record<string, unknown>> }) => {
    return renderOperations(
      HOTEL_SURFACE_ID,
      CUSTOM_CATALOG_ID,
      HOTEL_SCHEMA,
      { hotels },
    );
  },
  {
    name: "search_hotels",
    description:
      "Search for hotels and display the results as rich cards with star ratings. " +
      "Each hotel must have: id, name (e.g. 'The Plaza'), location " +
      "(e.g. 'Midtown Manhattan, NYC'), rating (float 0-5, e.g. 4.5), and " +
      "price (per night, e.g. '$350'). Generate 3-4 realistic results.",
    schema: {
      type: "object",
      properties: {
        hotels: {
          type: "array",
          items: { type: "object" },
          description: "Array of hotel result objects.",
        },
      },
      required: ["hotels"],
    } as any,
  },
);

const a2uiFixedSchemaAgent = createAgent({
  model: "openai:gpt-4o",
  tools: [searchFlights, searchHotels],
  middleware: [copilotkitMiddleware],
  systemPrompt: `You are a helpful travel assistant that can search for flights and hotels.

When the user asks about flights, use the search_flights tool.
When the user asks about hotels, use the search_hotels tool.
IMPORTANT: After calling a tool, do NOT repeat or summarize the data in your text response. The tool renders a rich UI automatically. Just say something brief like "Here are your results" or ask if they'd like to book.

For flights, each needs: id, airline, airlineLogo (Google favicon API), flightNumber, origin, destination,
date, departureTime, arrivalTime, duration, status, and price.

For hotels, each needs: id, name, location, rating (float 0-5), and price (per night).

Generate 3-5 realistic results.`,
});

// Export the inner graph, not the ReactAgent wrapper, so LangGraph Platform can
// inject its managed checkpointer (the wrapper swallows the injection —
// langchainjs#10144 — causing MISSING_CHECKPOINTER on the 2nd turn deployed).
export const a2uiFixedSchemaGraph = a2uiFixedSchemaAgent.graph;
