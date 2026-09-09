import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";

import { createDojoAgent } from "./factory";

function temperatureFor(location: string): number {
  const hash = [...location].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return 16 + (hash % 13);
}

function createWeatherTool() {
  return new FunctionTool({
    name: "get_weather",
    description: "Get current weather information for a location.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: {
          type: Type.STRING,
          description: "City or location to look up.",
        },
      },
      required: ["location"],
    },
    execute: (input) => {
      const location = String(
        (input as { location?: unknown } | undefined)?.location ?? "",
      );
      if (!location) {
        throw new Error("location is required");
      }
      const temperature = temperatureFor(location);
      return {
        location,
        temperature,
        feels_like: temperature - 1,
        humidity: 58,
        wind_speed: 9,
        conditions: temperature > 23 ? "sunny" : "partly cloudy",
      };
    },
  });
}

export function createBackendToolRenderingAgent() {
  return createDojoAgent({
    name: "adk_js_backend_tool_rendering",
    instruction:
      "You are a weather assistant. Always call get_weather for weather questions, then summarize the result briefly.",
    createTools: () => [createWeatherTool()],
  });
}
