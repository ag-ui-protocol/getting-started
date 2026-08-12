"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import { 
  useRenderTool,
  useConfigureSuggestions,
  CopilotChat,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import { CopilotKit } from "@copilotkit/react-core";

/** Shape of the `get_weather` tool result once parsed out of its JSON string. */
type WeatherResult = {
  city?: string;
  temperature?: number;
  humidity?: number;
  windSpeed?: number;
  wind_speed?: number;
  conditions?: string;
  feels_like?: number;
  feelsLike?: number;
};

interface AgenticChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const AgenticChat: React.FC<AgenticChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="backend_tool_rendering"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  useRenderTool({
    
    name: "get_weather",
    parameters: z.object({
      location: z.string(),
    })  ,
    render: ({ parameters, result, status }) => {
      if (status !== "complete") {
        return (
          <div className=" bg-[#667eea] text-white p-4 rounded-lg max-w-md">
            <span className="animate-spin">⚙️ Retrieving weather...</span>
          </div>
        );
      }

      // Some integrations (e.g. LangGraph) deliver tool results as a JSON-encoded
      // string in the ToolMessage content rather than a parsed object. Normalize
      // so property access works in either case; otherwise every field falls
      // through to its `|| 0` default and the card shows 0° C.
      let parsed: unknown = result;
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          parsed = {};
        }
      }
      const weather = (parsed ?? {}) as WeatherResult;

      const weatherResult: WeatherToolResult = {
        temperature: weather.temperature ?? 0,
        conditions: weather.conditions ?? "clear",
        humidity: weather.humidity ?? 0,
        windSpeed: weather.wind_speed ?? weather.windSpeed ?? 0,
        feelsLike:
          weather.feels_like ?? weather.feelsLike ?? weather.temperature ?? 0,
      };

      const themeColor = getThemeColor(weatherResult.conditions);

      return (
        <WeatherCard
          location={parameters.location}
          themeColor={themeColor}
          result={weatherResult}
          status={status || "complete"}
        />
      );
    },
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Weather in San Francisco",
        message: "What's the weather like in San Francisco?",
      },
      {
        title: "Weather in New York",
        message: "Tell me about the weather in New York.",
      },
      {
        title: "Weather in Tokyo",
        message: "How's the weather in Tokyo today?",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="backend_tool_rendering"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

interface WeatherToolResult {
  temperature: number;
  conditions: string;
  humidity: number;
  windSpeed: number;
  feelsLike: number;
}

function getThemeColor(conditions: string): string {
  const conditionLower = conditions.toLowerCase();
  if (conditionLower.includes("clear") || conditionLower.includes("sunny")) {
    return "#667eea";
  }
  if (conditionLower.includes("rain") || conditionLower.includes("storm")) {
    return "#4A5568";
  }
  if (conditionLower.includes("cloud")) {
    return "#718096";
  }
  if (conditionLower.includes("snow")) {
    return "#63B3ED";
  }
  return "#764ba2";
}

function WeatherCard({
  location,
  themeColor,
  result,
  status,
}: {
  location?: string;
  themeColor: string;
  result: WeatherToolResult;
  status: "inProgress" | "executing" | "complete";
}) {
  return (
    <div
      data-testid="weather-card"
      style={{ backgroundColor: themeColor }}
      className="rounded-xl mt-6 mb-4 max-w-md w-full"
    >
      <div className="bg-white/20 p-4 w-full">
        <div className="flex items-center justify-between">
          <div>
            <h3 data-testid="weather-city" className="text-xl font-bold text-white capitalize">
              {location}
            </h3>
            <p className="text-white">Current Weather</p>
          </div>
          <WeatherIcon conditions={result.conditions} />
        </div>

        <div className="mt-4 flex items-end justify-between">
          <div className="text-3xl font-bold text-white">
            <span className="">{result.temperature}° C</span>
            <span className="text-sm text-white/50">
              {" / "}
              {((result.temperature * 9) / 5 + 32).toFixed(1)}° F
            </span>
          </div>
          <div className="text-sm text-white capitalize">{result.conditions}</div>
        </div>

        <div className="mt-4 pt-4 border-t border-white">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div data-testid="weather-humidity">
              <p className="text-white text-xs">Humidity</p>
              <p className="text-white font-medium">{result.humidity}%</p>
            </div>
            <div data-testid="weather-wind">
              <p className="text-white text-xs">Wind</p>
              <p className="text-white font-medium">{result.windSpeed} mph</p>
            </div>
            <div data-testid="weather-feels-like">
              <p className="text-white text-xs">Feels Like</p>
              <p className="text-white font-medium">{result.feelsLike}°</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WeatherIcon({ conditions }: { conditions: string }) {
  if (!conditions) return null;

  if (conditions.toLowerCase().includes("clear") || conditions.toLowerCase().includes("sunny")) {
    return <SunIcon />;
  }

  if (
    conditions.toLowerCase().includes("rain") ||
    conditions.toLowerCase().includes("drizzle") ||
    conditions.toLowerCase().includes("snow") ||
    conditions.toLowerCase().includes("thunderstorm")
  ) {
    return <RainIcon />;
  }

  if (
    conditions.toLowerCase().includes("fog") ||
    conditions.toLowerCase().includes("cloud") ||
    conditions.toLowerCase().includes("overcast")
  ) {
    return <CloudIcon />;
  }

  return <CloudIcon />;
}

// Simple sun icon for the weather card
function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="w-14 h-14 text-yellow-200"
    >
      <circle cx="12" cy="12" r="5" />
      <path
        d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
        strokeWidth="2"
        stroke="currentColor"
      />
    </svg>
  );
}

function RainIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="w-14 h-14 text-blue-200"
    >
      {/* Cloud */}
      <path
        d="M7 15a4 4 0 0 1 0-8 5 5 0 0 1 10 0 4 4 0 0 1 0 8H7z"
        fill="currentColor"
        opacity="0.8"
      />
      {/* Rain drops */}
      <path
        d="M8 18l2 4M12 18l2 4M16 18l2 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="w-14 h-14 text-gray-200"
    >
      <path d="M7 15a4 4 0 0 1 0-8 5 5 0 0 1 10 0 4 4 0 0 1 0 8H7z" fill="currentColor" />
    </svg>
  );
}

export default AgenticChat;
