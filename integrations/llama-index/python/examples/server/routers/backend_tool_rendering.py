"""Backend Tool Rendering feature."""

from __future__ import annotations

from datetime import datetime
import json
import os
from textwrap import dedent
from zoneinfo import ZoneInfo

import httpx
from llama_index.llms.openai import OpenAI
from llama_index.protocols.ag_ui.router import get_ag_ui_workflow_router


def get_weather_condition(code: int) -> str:
    """Map weather code to human-readable condition.

    Args:
        code: WMO weather code.

    Returns:
        Human-readable weather condition string.
    """
    conditions = {
        0: "Clear sky",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Foggy",
        48: "Depositing rime fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        56: "Light freezing drizzle",
        57: "Dense freezing drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        66: "Light freezing rain",
        67: "Heavy freezing rain",
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
    return conditions.get(code, "Unknown")


def _mock_weather(location: str) -> str:
    """Return deterministic canned weather data for tests.

    Used when ``AG_UI_MOCK_WEATHER`` is set so e2e runs don't depend on the
    live open-meteo API (which rate-limits CI's shared egress IPs).
    """
    return json.dumps({
        "temperature": 21.0,
        "feelsLike": 20.0,
        "humidity": 65.0,
        "windSpeed": 12.0,
        "windGust": 18.0,
        "conditions": get_weather_condition(1),
        "location": location,
    })


async def get_weather(location: str) -> str:
    """Get current weather for a location.

    Args:
        location: City name.

    Returns:
        Dictionary with weather information including temperature, feels like,
        humidity, wind speed, wind gust, conditions, and location name.
    """
    if os.getenv("AG_UI_MOCK_WEATHER"):
        return _mock_weather(location)

    async with httpx.AsyncClient() as client:
        # Geocode the location
        geocoding_url = (
            f"https://geocoding-api.open-meteo.com/v1/search?name={location}&count=1"
        )
        geocoding_response = await client.get(geocoding_url)
        geocoding_data = geocoding_response.json()

        if not geocoding_data.get("results"):
            raise ValueError(f"Location '{location}' not found")

        result = geocoding_data["results"][0]
        latitude = result["latitude"]
        longitude = result["longitude"]
        name = result["name"]

        # Get weather data
        weather_url = (
            f"https://api.open-meteo.com/v1/forecast?"
            f"latitude={latitude}&longitude={longitude}"
            f"&current=temperature_2m,apparent_temperature,relative_humidity_2m,"
            f"wind_speed_10m,wind_gusts_10m,weather_code"
        )
        weather_response = await client.get(weather_url)
        weather_data = weather_response.json()

        current = weather_data["current"]

        return json.dumps({
            "temperature": current["temperature_2m"],
            "feelsLike": current["apparent_temperature"],
            "humidity": current["relative_humidity_2m"],
            "windSpeed": current["wind_speed_10m"],
            "windGust": current["wind_gusts_10m"],
            "conditions": get_weather_condition(current["weather_code"]),
            "location": name,
        })


# Create the router with weather tools
backend_tool_rendering_router = get_ag_ui_workflow_router(
    llm=OpenAI(model="gpt-4o-mini"),
    backend_tools=[get_weather],
    system_prompt=dedent(
        """
        You are a helpful weather assistant that provides accurate weather information.

      Your primary function is to help users get weather details for specific locations. When responding:
      - Always ask for a location if none is provided
      - If the location name isn’t in English, please translate it
      - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
      - Include relevant details like humidity, wind conditions, and precipitation
      - Keep responses concise but informative

      Use the get_weather tool to fetch current weather data.
        """
    ),
)
