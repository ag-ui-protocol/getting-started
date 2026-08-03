"""A2UI fixed-schema flow.

Unlike the dynamic demo (which auto-injects generate_a2ui to GENERATE a
surface), the fixed-schema demo wires two backend tools, ``search_flights`` and
``search_hotels``. The component layout is pre-authored JSON loaded at import;
only the data changes per call. Each tool returns the ``a2ui_operations``
envelope (createSurface -> updateComponents -> updateDataModel) as a tool
result, which the frontend A2UIMiddleware detects and paints. No sub-agent, no
generation, no recovery.
"""

import json
import logging
from pathlib import Path
from typing import Any

from crewai.flow.flow import Flow, start
from litellm import acompletion

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    create_surface,
    update_components,
    update_data_model,
)

from ..sdk import copilotkit_emit_tool_result, copilotkit_stream

logger = logging.getLogger("ag_ui_crewai")

MODEL = "openai/gpt-4o"

# Both surfaces render against the dojo's fixed catalog (Row / FlightCard /
# HotelCard / StarRating); the dojo page supplies the catalog components, we
# only reference its id in createSurface.
FIXED_CATALOG_ID = "https://a2ui.org/demos/dojo/fixed_catalog.json"

_SCHEMAS_DIR = Path(__file__).parent / "a2ui_fixed_schema_schemas"


def _load_schema(name: str) -> list[dict[str, Any]]:
    with open(_SCHEMAS_DIR / name, encoding="utf-8") as f:
        return json.load(f)


FLIGHT_SURFACE_ID = "flight-search-results"
FLIGHT_SCHEMA = _load_schema("flight_schema.json")
HOTEL_SURFACE_ID = "hotel-search-results"
HOTEL_SCHEMA = _load_schema("hotel_schema.json")


def _envelope(surface_id: str, schema: list[dict[str, Any]], data: dict[str, Any]) -> str:
    """Build the A2UI operations envelope JSON for a fixed-schema surface."""
    return json.dumps(
        {
            A2UI_OPERATIONS_KEY: [
                create_surface(surface_id, catalog_id=FIXED_CATALOG_ID),
                update_components(surface_id, schema),
                update_data_model(surface_id, data),
            ]
        }
    )


SEARCH_FLIGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "search_flights",
        "description": "Search for flights and display the results as rich cards.",
        "parameters": {
            "type": "object",
            "properties": {
                "flights": {
                    "type": "array",
                    "description": (
                        "Flight objects, each with: id, airline, airlineLogo "
                        "(Google favicon API: "
                        "https://www.google.com/s2/favicons?domain={airline_domain}&sz=128), "
                        "flightNumber, origin, destination, date (short readable, "
                        "near-future), departureTime, arrivalTime, duration, "
                        "status, price."
                    ),
                    "items": {"type": "object"},
                }
            },
            "required": ["flights"],
        },
    },
}

SEARCH_HOTELS_TOOL = {
    "type": "function",
    "function": {
        "name": "search_hotels",
        "description": "Search for hotels and display the results as rich cards with star ratings.",
        "parameters": {
            "type": "object",
            "properties": {
                "hotels": {
                    "type": "array",
                    "description": (
                        "Hotel objects, each with: id, name, location, rating "
                        "(float 0-5), price (per night). Generate 3-4 realistic "
                        "results."
                    ),
                    "items": {"type": "object"},
                }
            },
            "required": ["hotels"],
        },
    },
}

SYSTEM_PROMPT = (
    "You are a helpful travel assistant that can search for flights and hotels. "
    "When the user asks about flights, use the search_flights tool; for hotels, "
    "use search_hotels. After calling a tool, do NOT repeat or summarize the "
    "data in your text response; the tool renders a rich UI automatically. Just "
    "say something brief like 'Here are your results'. Generate 3-5 realistic "
    "results."
)

_TOOL_ENVELOPE = {
    "search_flights": lambda args: _envelope(
        FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, {"flights": args.get("flights", [])}
    ),
    "search_hotels": lambda args: _envelope(
        HOTEL_SURFACE_ID, HOTEL_SCHEMA, {"hotels": args.get("hotels", [])}
    ),
}


class A2UIFixedSchemaFlow(Flow):
    """A2UI surfaces from fixed, pre-authored schemas via direct backend tools."""

    @start()
    async def chat(self):
        state = self.state
        actions = (state.get("copilotkit") or {}).get("actions") or []
        tools = [*actions, SEARCH_FLIGHTS_TOOL, SEARCH_HOTELS_TOOL]

        response = await copilotkit_stream(
            await acompletion(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    *state["messages"],
                ],
                tools=tools,
                parallel_tool_calls=False,
                stream=True,
            )
        )
        message = response.choices[0].message
        # Preserve the streamed message id so the terminal MESSAGES_SNAPSHOT
        # updates the assistant message in place rather than re-appending it
        # after the already-streamed surface (which would drop the tool-call
        # chip to the end).
        assistant = message.model_dump()
        stream_id = getattr(response, "id", None)
        if stream_id:
            assistant["id"] = stream_id
        state["messages"].append(assistant)

        if not message.tool_calls:
            return

        for tool_call in message.tool_calls:
            build = _TOOL_ENVELOPE.get(tool_call.function.name)
            if build is None:
                continue
            try:
                args = json.loads(tool_call.function.arguments or "{}")
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "%s tool-call args were not valid JSON; rendering an empty "
                    "surface: %r",
                    tool_call.function.name,
                    tool_call.function.arguments,
                )
                args = {}
            envelope = build(args)
            state["messages"].append(
                {
                    "role": "tool",
                    "content": envelope,
                    "tool_call_id": tool_call.id,
                }
            )
            # The A2UI middleware paints the fixed surface from the tool RESULT
            # (a2ui_operations envelope), which the bridge otherwise surfaces
            # only via MESSAGES_SNAPSHOT. Emit it as a TOOL_CALL_RESULT so the
            # middleware detects and renders it.
            await copilotkit_emit_tool_result(tool_call.id, envelope)
