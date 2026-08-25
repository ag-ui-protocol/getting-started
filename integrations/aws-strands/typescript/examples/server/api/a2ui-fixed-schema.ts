/**
 * A2UI Fixed Schema example for AWS Strands (TypeScript, OSS-158).
 *
 * Strands port of the LangGraph / ADK `a2ui_fixed_schema` demo. Unlike the
 * dynamic demo (which relies on the adapter auto-injecting `generate_a2ui` to
 * *generate* a surface), the fixed-schema demo wires two plain backend tools —
 * `search_flights` and `search_hotels`. The component layout is fixed (the
 * `*_SCHEMA` consts below); only the *data* changes per call. Each tool returns
 * the `a2ui_operations` envelope (createSurface -> updateComponents ->
 * updateDataModel), which the runtime's A2UIMiddleware detects in the tool
 * result and paints. No sub-agent, no generation, no recovery loop.
 *
 * The tool returns the envelope as a JSON string (via `wrapAsOperationsEnvelope`)
 * so the Strands adapter lands it in a `text` block the client A2UIMiddleware
 * scans for `a2ui_operations`.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent } from "@ag-ui/aws-strands";
import {
  A2UI_OPERATIONS_KEY,
  createSurface,
  updateComponents,
  updateDataModel,
} from "@ag-ui/a2ui-toolkit";
import { createModel } from "../model-factory";

// Both surfaces render against the dojo's fixed catalog (Row / FlightCard /
// HotelCard / StarRating). The dojo page supplies the catalog via the
// CopilotKit `a2ui` prop; here we only reference its id in createSurface.
const CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/fixed_catalog.json";

const FLIGHT_SURFACE_ID = "flight-search-results";
const HOTEL_SURFACE_ID = "hotel-search-results";

// Fixed, pre-authored component layouts. Mirror
// python/examples/server/api/a2ui_fixed_schema_schemas/{flight,hotel}_schema.json.
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

// Return the envelope as a plain OBJECT (not a JSON string): the Strands TS
// SDK wraps an object tool-return in a `json` content block the adapter reads
// and re-stringifies into the TOOL_CALL_RESULT the client A2UIMiddleware scans
// for `a2ui_operations`. A bare string return lands in no content block and the
// result comes through empty (unlike the Python SDK, which wraps strings).
function envelope(
  surfaceId: string,
  schema: Array<Record<string, unknown>>,
  data: unknown,
): Record<string, unknown> {
  return {
    [A2UI_OPERATIONS_KEY]: [
      createSurface(surfaceId, CUSTOM_CATALOG_ID),
      updateComponents(surfaceId, schema),
      updateDataModel(surfaceId, data),
    ],
  };
}

const searchFlights = tool({
  name: "search_flights",
  description: "Search for flights and display the results as rich cards.",
  inputSchema: z.object({
    flights: z
      .array(z.record(z.string(), z.any()))
      .describe(
        "A list of flight objects. Each flight must have: id, airline (e.g. " +
          '"United Airlines"), airlineLogo (Google favicon API: ' +
          '"https://www.google.com/s2/favicons?domain={airline_domain}&sz=128"), ' +
          "flightNumber, origin, destination, date (short readable format like " +
          '"Tue, Mar 18" — use near-future dates), departureTime, arrivalTime, ' +
          'duration (e.g. "4h 25m"), status (e.g. "On Time" or "Delayed"), ' +
          'and price (e.g. "$289").',
      ),
  }),
  callback: ({ flights }) => envelope(FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, { flights }),
});

const searchHotels = tool({
  name: "search_hotels",
  description:
    "Search for hotels and display the results as rich cards with star ratings.",
  inputSchema: z.object({
    hotels: z
      .array(z.record(z.string(), z.any()))
      .describe(
        "A list of hotel objects. Each hotel must have: id, name (e.g. " +
          '"The Plaza"), location (e.g. "Midtown Manhattan, NYC"), ' +
          "rating (float 0-5, e.g. 4.5), and price (per night, e.g. \"$350\"). " +
          "Generate 3-4 realistic hotel results.",
      ),
  }),
  callback: ({ hotels }) => envelope(HOTEL_SURFACE_ID, HOTEL_SCHEMA, { hotels }),
});

const SYSTEM_PROMPT = `You are a helpful travel assistant that can search for flights and hotels.

When the user asks about flights, use the search_flights tool.
When the user asks about hotels, use the search_hotels tool.
IMPORTANT: After calling a tool, do NOT repeat or summarize the data in your text response. The tool renders a rich UI automatically. Just say something brief like "Here are your results" or ask if they'd like to book.

For flights, each needs: id, airline, airlineLogo (Google favicon API), flightNumber, origin, destination,
date, departureTime, arrivalTime, duration, status, and price.

For hotels, each needs: id, name, location, rating (float 0-5), and price (per night).

Generate 3-5 realistic results.`;

export async function createA2UIFixedSchemaAgent(): Promise<StrandsAgent> {
  const agent = new Agent({
    // Chat Completions API: the Responses adapter buffers tool-call argument
    // deltas, which would defeat A2UI's progressive surface streaming.
    model: await createModel({ openaiApi: "chat" }),
    systemPrompt: SYSTEM_PROMPT,
    tools: [searchFlights, searchHotels],
  });

  return new StrandsAgent({
    agent,
    name: "a2ui_fixed_schema",
    description:
      "A2UI surfaces from fixed, pre-authored schemas (direct backend tools)",
  });
}
