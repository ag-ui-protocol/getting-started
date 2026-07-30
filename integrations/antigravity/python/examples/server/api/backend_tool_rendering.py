"""Backend tool rendering: a server-side tool, streamed to the UI as it runs.

The dojo page for this feature registers a `useRenderTool` for `get_weather`
and draws a weather card from the tool's result, so the point of the demo is
that a tool executed *on the server* is visible on the client -- call, then
arguments, then result.

Antigravity runs a custom Python tool through the SDK's own `ToolRunner`, and
the harness reports it as a single `TOOL_CALL`/`ACTIVE` step: there is no DONE
step and no result anywhere on `Step`, because the return value goes back over
the WebSocket straight to the model. The adapter therefore emits the call and
its `TOOL_CALL_RESULT` itself (see `UIBridge.build_server_tools`) -- without
that the card would spin forever waiting for a result that never arrives.

The harness' own built-in tools stay enabled, since they are backend tools too,
and the harness *does* report those at DONE with their output folded into the
call arguments.

`tool_approval=True` is deliberately NOT set. It routes every non-auto-approved
call through an AG-UI approval *interrupt*, and the dojo answers frontend tools
(`ToolMessage`) rather than interrupts (`RunAgentInput.resume`) -- so the first
`create_file` would park on a prompt nothing can answer and the run would hang.
It looks fine until you ask for a write, because reads are auto-approved.

Enable it against a client that implements the interrupt protocol; the adapter
then also stops needing the `allow_all` fallback for the SDK's write-tool
safety guard.
"""

from __future__ import annotations

import json
import logging
import os

import httpx
from google.antigravity import CapabilitiesConfig
from google.antigravity.types import BuiltinTools

from ._common import WORKSPACE, build

logger = logging.getLogger(__name__)

# WMO weather codes, as returned by open-meteo's `weather_code`.
_CONDITIONS = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}


def _condition(code: int) -> str:
    return _CONDITIONS.get(code, "Unknown")


def _canned(location: str) -> str:
    """Deterministic weather, for offline demos and e2e runs.

    open-meteo needs no API key but does need the network, and it rate-limits
    shared CI egress. Set ``AG_UI_MOCK_WEATHER=1`` to force this path.
    """
    return json.dumps(
        {
            "temperature": 21.0,
            "feelsLike": 20.0,
            "humidity": 65.0,
            "windSpeed": 12.0,
            "windGust": 18.0,
            "conditions": _condition(1),
            "location": location,
        }
    )


async def get_weather(location: str) -> str:
    """Gets the current weather for a location.

    Args:
      location: The city to look up, for example "Tokyo".
    """
    if os.environ.get("AG_UI_MOCK_WEATHER"):
        return _canned(location)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            geo = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": location, "count": 1},
            )
            geo.raise_for_status()
            matches = geo.json().get("results") or []
            if not matches:
                # Returned, not raised: the model should tell the user the place
                # was not found rather than report a tool crash.
                return json.dumps(
                    {"error": f"I could not find a place called {location!r}."}
                )
            place = matches[0]

            forecast = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": place["latitude"],
                    "longitude": place["longitude"],
                    "current": (
                        "temperature_2m,apparent_temperature,relative_humidity_2m,"
                        "wind_speed_10m,wind_gusts_10m,weather_code"
                    ),
                },
            )
            forecast.raise_for_status()
            current = forecast.json()["current"]
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        # A demo that renders a broken card teaches nothing; fall back loudly.
        logger.warning("open-meteo lookup failed (%s); using canned data", exc)
        return _canned(location)

    return json.dumps(
        {
            "temperature": current["temperature_2m"],
            "feelsLike": current["apparent_temperature"],
            "humidity": current["relative_humidity_2m"],
            "windSpeed": current["wind_speed_10m"],
            "windGust": current["wind_gusts_10m"],
            "conditions": _condition(current["weather_code"]),
            "location": place["name"],
        }
    )


agent = build(
    system_instructions=(
        "You are a helpful weather assistant.\n"
        "- Use the get_weather tool for any weather question; never guess.\n"
        "- If the location is not in English, translate it first. For a "
        'multi-part place like "New York, NY", use the main part.\n'
        "- After the tool returns, summarise it in one or two short sentences. "
        "The user can already see a weather card, so do not repeat every "
        "number.\n"
        "- If no location is given, ask which one.\n"
        "You also have filesystem and shell tools scoped to "
        f"{WORKSPACE}; use those only when the user asks about files."
    ),
    tools=[get_weather],
    # search_web returns an empty summary without Google credentials, which
    # sends the model into a retry loop; the filesystem tools work, so expose
    # only those.
    capabilities=CapabilitiesConfig(
        enabled_tools=[
            BuiltinTools.LIST_DIR,
            BuiltinTools.VIEW_FILE,
            BuiltinTools.FIND_FILE,
            BuiltinTools.SEARCH_DIR,
            BuiltinTools.CREATE_FILE,
            BuiltinTools.EDIT_FILE,
            BuiltinTools.RUN_COMMAND,
            BuiltinTools.FINISH,
        ],
        enable_subagents=False,
    ),
)
