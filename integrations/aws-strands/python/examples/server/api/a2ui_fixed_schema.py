"""A2UI Fixed Schema example for AWS Strands (OSS-158).

Strands port of the LangGraph / ADK ``a2ui_fixed_schema`` demo. Unlike the
dynamic demo (which relies on the adapter auto-injecting ``generate_a2ui`` to
*generate* a surface), the fixed-schema demo wires two plain backend ``@tool``
functions — ``search_flights`` and ``search_hotels``. The component layout is
loaded from JSON files at startup; only the *data* changes per call. Each tool
returns the ``a2ui_operations`` envelope (createSurface -> updateComponents ->
updateDataModel), which the runtime's A2UIMiddleware detects in the tool result
and paints. No sub-agent, no generation, no recovery loop.

The tool returns the envelope as a JSON **string** (not a dict): the Strands
adapter reads the ``toolResult`` ``text`` block, ``json.loads`` it, then
``json.dumps`` it back into the ToolCallResult content the client's
A2UIMiddleware scans for ``a2ui_operations``. Returning a string is what lands
the payload in a ``text`` block (a bare dict may land in a ``json`` block the
adapter skips).
"""
import json
import os
from pathlib import Path
from typing import Any, List

from dotenv import load_dotenv

# Suppress OpenTelemetry context warnings from Strands SDK
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent, tool
from ag_ui_strands import StrandsAgent, create_strands_app
from server.model_factory import create_model

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    create_surface,
    update_components,
    update_data_model,
)

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Both surfaces render against the dojo's fixed catalog (Row / FlightCard /
# HotelCard / StarRating). The dojo page supplies the catalog via the
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
) -> str:
    """Build the A2UI operations envelope for a fixed-schema surface.

    Returned as a JSON string so the Strands adapter emits it in a ``text``
    block the client A2UIMiddleware can detect.
    """
    return json.dumps(
        {
            A2UI_OPERATIONS_KEY: [
                create_surface(surface_id, catalog_id=CUSTOM_CATALOG_ID),
                update_components(surface_id, schema),
                update_data_model(surface_id, data),
            ]
        }
    )


@tool
def search_flights(flights: List[dict]) -> str:
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
            and price (e.g. "$289").
    """
    return _envelope(FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, {"flights": flights})


@tool
def search_hotels(hotels: List[dict]) -> str:
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
date, departureTime, arrivalTime, duration, status, and price.

For hotels, each needs: id, name, location, rating (float 0-5), and price (per night).

Generate 3-5 realistic results."""

strands_agent = Agent(
    # Chat Completions API (OpenAI provider only; other providers ignore the
    # kwarg): the Responses model buffers tool-call argument deltas, which
    # would defeat A2UI's progressive surface streaming.
    model=create_model(openai_api="chat"),
    system_prompt=SYSTEM_PROMPT,
    tools=[search_flights, search_hotels],
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="a2ui_fixed_schema",
    description="A2UI surfaces from fixed, pre-authored schemas (direct backend tools)",
)

app = create_strands_app(agui_agent, "/")
