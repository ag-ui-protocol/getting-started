"""Backend Tool Rendering example using AG2 with AG-UI protocol.

Exposes an Agent with a get_weather tool via AGUIStream.
The frontend renders tool calls and results (e.g. weather card).
See: https://docs.ag2.ai/latest/docs/user-guide/ag-ui/
"""

import json
import os

import httpx
from fastapi import FastAPI
from ag2 import Agent, tool
from ag2.ag_ui import AGUIStream
from ag2.config import OpenAIConfig


def get_weather_condition(code: int) -> str:
    """Map WMO weather code to human-readable condition."""
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
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        71: "Slight snow fall",
        73: "Moderate snow fall",
        75: "Heavy snow fall",
        80: "Slight rain showers",
        81: "Moderate rain showers",
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
        "feels_like": 20.0,
        "humidity": 65.0,
        "wind_speed": 12.0,
        "wind_gust": 18.0,
        "conditions": get_weather_condition(1),
        "location": location,
    })


@tool
async def get_weather(location: str) -> str:
    """Get current weather for a location.

    Args:
        location: City name.

    Returns:
        Dictionary with temperature, conditions, humidity, wind_speed, feels_like, location.
    """
    if os.getenv("AG_UI_MOCK_WEATHER"):
        return _mock_weather(location)

    async with httpx.AsyncClient() as client:
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
            "feels_like": current["apparent_temperature"],
            "humidity": current["relative_humidity_2m"],
            "wind_speed": current["wind_speed_10m"],
            "wind_gust": current["wind_gusts_10m"],
            "conditions": get_weather_condition(current["weather_code"]),
            "location": name,
        })


agent = Agent(
    name="weather_bot",
    prompt="""You are a helpful weather assistant that provides accurate weather information.

Your primary function is to help users get weather details for specific locations. When responding:
- Always ask for a location if none is provided
- If the location name isn't in English, please translate it
- If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
- Include relevant details like humidity, wind conditions, and precipitation
- Keep responses concise but informative

Use the get_weather tool to fetch current weather data.""",
    config=OpenAIConfig(model="gpt-4o-mini"),
    tools=[get_weather],
)

stream = AGUIStream(agent)
backend_tool_rendering_app = FastAPI()
backend_tool_rendering_app.mount("", stream.build_asgi())
