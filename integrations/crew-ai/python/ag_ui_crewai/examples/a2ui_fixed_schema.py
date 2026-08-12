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
import uuid
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
from ._model_turn import (
    append_assistant_message,
    resolve_client_tools,
    sort_tool_calls,
)

logger = logging.getLogger("ag_ui_crewai")

MODEL = "openai/gpt-5.4"

# Model turns per run: one search plus its closing reply, with headroom for a
# flight-and-hotel request. Bounded so a model that keeps calling tools cannot
# spin the run.
MAX_MODEL_TURNS = 4

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
    "results.\n\n"
    "The conversation may already contain a report that the user interacted with "
    "results you rendered earlier (booked a hotel or selected a flight, for "
    "example). That report is history, not a new request: do NOT run another "
    "search and do NOT call any tool. Reply in text, naming the specific item the "
    "user chose and what happens next."
)


def _results(args: dict[str, Any], key: str) -> list:
    """The results list for a search call. A missing OR explicitly-null argument
    becomes an empty list: ``updateDataModel {"hotels": null}`` paints nothing at
    all, where an empty surface is what a no-results search means."""
    value = args.get(key)
    return value if isinstance(value, list) else []


_TOOL_ENVELOPE = {
    "search_flights": lambda args: _envelope(
        FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, {"flights": _results(args, "flights")}
    ),
    "search_hotels": lambda args: _envelope(
        HOTEL_SURFACE_ID, HOTEL_SCHEMA, {"hotels": _results(args, "hotels")}
    ),
}


class A2UIFixedSchemaFlow(Flow):
    """A2UI surfaces from fixed, pre-authored schemas via direct backend tools.

    Loops the model over its own tool results (bounded by ``MAX_MODEL_TURNS``)
    so a turn that ends in a search still gets a closing model reply.

    What the loop does for a user action on a rendered surface, precisely: the
    middleware appends the action and its report to the NEXT run's input, so the
    report is already in history on the first turn and a model that answers it in
    text needs no loop at all. The loop saves the case the live model actually
    takes: it tool-calls FIRST (running another search), which without a loop
    would end the run on that call and leave the user's choice unacknowledged.
    """

    @start()
    async def chat(self):
        state = self.state
        actions = (state.get("copilotkit") or {}).get("actions") or []
        # A frontend action sharing a search tool's name is dropped in favour of
        # the backend tool (and logged), so the model is offered one tool per name
        # rather than two definitions of the same one.
        offered, client_names = resolve_client_tools(
            actions, backend_names=set(_TOOL_ENVELOPE)
        )
        tools = [*offered, SEARCH_FLIGHTS_TOOL, SEARCH_HOTELS_TOOL]

        for _ in range(MAX_MODEL_TURNS):
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
            tool_calls = message.tool_calls or []
            # An orphan call (a name neither this flow's searches nor a frontend
            # tool) is answered by nobody, so it is dropped instead of persisted:
            # an assistant tool_calls entry with no matching tool result 400s
            # every later run on this thread.
            backend, client, orphan = sort_tool_calls(
                tool_calls,
                backend_names=set(_TOOL_ENVELOPE),
                client_names=client_names,
            )
            append_assistant_message(
                state, response, message, drop_indexes={i for i, _ in orphan}
            )

            if not tool_calls:
                return

            for _, tool_call in backend:
                build = _TOOL_ENVELOPE[tool_call.function.name]
                try:
                    args = json.loads(tool_call.function.arguments or "{}")
                except (json.JSONDecodeError, TypeError):
                    logger.warning(
                        "%s tool-call args were not valid JSON; rendering an "
                        "empty surface: %r",
                        tool_call.function.name,
                        tool_call.function.arguments,
                    )
                    args = {}
                envelope = build(args)
                # One id for the streamed result and the persisted message: the
                # terminal MESSAGES_SNAPSHOT then updates that message in place.
                # Left unstamped, the snapshot mints a second id and the client
                # remounts the surface card it just painted.
                result_id = str(uuid.uuid4())
                state["messages"].append(
                    {
                        "id": result_id,
                        "role": "tool",
                        "content": envelope,
                        "tool_call_id": tool_call.id,
                    }
                )
                # The A2UI middleware paints the fixed surface from the tool
                # RESULT (a2ui_operations envelope), which the bridge otherwise
                # surfaces only via MESSAGES_SNAPSHOT. Emit it as a
                # TOOL_CALL_RESULT so the middleware detects and renders it.
                await copilotkit_emit_tool_result(
                    tool_call.id, envelope, message_id=result_id
                )

            # A frontend call ends the run so the client can run it and send the
            # result back on the next one; feeding the model again here would
            # leave that call unanswered. An orphan call does NOT end the run: it
            # was dropped, so the history is well-formed, and ending here would
            # cost the user a reply. The model gets another turn to answer in text
            # instead, bounded by MAX_MODEL_TURNS.
            if client:
                return

        logger.warning(
            "Fixed-schema turn hit the %d-model-turn cap with the model still "
            "calling tools; ending the run without a closing reply",
            MAX_MODEL_TURNS,
        )
