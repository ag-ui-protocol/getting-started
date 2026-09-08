"""A2UI Fixed Schema feature (OSS-158).

ADK port of the LangGraph ``a2ui_fixed_schema`` example. Unlike the dynamic
demo (which forces a ``render_a2ui`` sub-agent to *generate* a surface), the
fixed-schema demo uses two plain ADK backend tools — ``search_flights`` and
``search_hotels``. The component layout is loaded from JSON files at startup
(``a2ui.load_schema`` equivalent); only the *data* changes per call. Each tool
returns the ``a2ui_operations`` envelope directly (createSurface ->
updateComponents -> updateDataModel), which the A2UI middleware detects in the
tool result and paints. No sub-agent, no generation, no recovery loop.

The result is returned as a Python ``dict`` (not a JSON string): ADK keeps a
dict tool-return as the function response as-is, and the middleware's
``_serialize_tool_response`` then ``json.dumps`` it into the
``{"a2ui_operations": [...]}`` string the client's A2UIMiddleware looks for.
Returning a string instead would make ADK wrap it as ``{"result": "..."}``,
which the middleware would not recognize.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List

from fastapi import FastAPI
from google.adk.agents import LlmAgent

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    create_surface,
    update_components,
    update_data_model,
)

# Both surfaces render against the dojo's fixed catalog (Row / FlightCard /
# HotelCard / StarRating). The client (dojo page) supplies the catalog via the
# CopilotKit `a2ui` prop; here we only reference its id in createSurface.
CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/fixed_catalog.json"

_SCHEMAS_DIR = Path(__file__).parent / "a2ui_fixed_schema_schemas"


def _load_schema(name: str) -> list[dict[str, Any]]:
    """Load a fixed A2UI component layout from a JSON file."""
    with open(_SCHEMAS_DIR / name) as f:
        return json.load(f)


FLIGHT_SURFACE_ID = "flight-search-results"
FLIGHT_SCHEMA = _load_schema("flight_schema.json")

HOTEL_SURFACE_ID = "hotel-search-results"
HOTEL_SCHEMA = _load_schema("hotel_schema.json")


def _envelope(
    surface_id: str, schema: list[dict[str, Any]], data: dict[str, Any]
) -> dict[str, Any]:
    """Build the A2UI operations envelope dict for a fixed-schema surface."""
    return {
        A2UI_OPERATIONS_KEY: [
            create_surface(surface_id, catalog_id=CUSTOM_CATALOG_ID),
            update_components(surface_id, schema),
            update_data_model(surface_id, data),
        ]
    }


def search_flights(flights: List[dict]) -> dict[str, Any]:
    """Search for flights and display the results as rich cards.

    Args:
        flights: A list of flight objects. Each flight must have:
            id, airline (e.g. "United Airlines"),
            airlineLogo (Google favicon API:
            "https://www.google.com/s2/favicons?domain={airline_domain}&sz=128"
            e.g. "https://www.google.com/s2/favicons?domain=united.com&sz=128"),
            flightNumber, origin, destination,
            date (short readable format like "Tue, Mar 18" — use near-future dates),
            departureTime, arrivalTime,
            duration (e.g. "4h 25m"), status (e.g. "On Time" or "Delayed"),
            statusIcon (colored dot: "https://placehold.co/12/22c55e/22c55e.png"
            for On Time, "https://placehold.co/12/eab308/eab308.png" for Delayed),
            and price (e.g. "$289").
    """
    return _envelope(FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, {"flights": flights})


def search_hotels(hotels: List[dict]) -> dict[str, Any]:
    """Search for hotels and display the results as rich cards with star ratings.

    Args:
        hotels: A list of hotel objects. Each hotel must have:
            id, name (e.g. "The Plaza"),
            location (e.g. "Midtown Manhattan, NYC"),
            rating (float 0-5, e.g. 4.5),
            and price (per night, e.g. "$350").

            Generate 3-4 realistic hotel results.
    """
    return _envelope(HOTEL_SURFACE_ID, HOTEL_SCHEMA, {"hotels": hotels})


SYSTEM_PROMPT = """You are a helpful travel assistant that can search for flights and hotels.

When the user asks about flights, use the search_flights tool.
When the user asks about hotels, use the search_hotels tool.
IMPORTANT: After calling a tool, do NOT repeat or summarize the data in your text response. The tool renders a rich UI automatically. Just say something brief like "Here are your results" or ask if they'd like to book.

For flights, each needs: id, airline, airlineLogo (Google favicon API), flightNumber, origin, destination,
date, departureTime, arrivalTime, duration, status, statusIcon, and price.

For hotels, each needs: id, name, location, rating (float 0-5), and price (per night).

Generate 3-5 realistic results."""

# gemini-2.5-pro reliably calls the right tool with well-formed data for this
# demo; keep it on the same model as the dynamic demo for parity.
_MODEL = "gemini-2.5-pro"

fixed_schema_agent = LlmAgent(
    model=_MODEL,
    name="a2ui_fixed_schema",
    instruction=SYSTEM_PROMPT,
    tools=[search_flights, search_hotels],
)

adk_a2ui_fixed_schema = ADKAgent(
    adk_agent=fixed_schema_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware A2UI Fixed Schema")
add_adk_fastapi_endpoint(app, adk_a2ui_fixed_schema, path="/")
