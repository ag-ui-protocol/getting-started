/**
 * Backend Tool Rendering example for AWS Strands (TypeScript).
 *
 * Demonstrates backend-executed tools. Tool results reach the frontend as
 * `TOOL_CALL_RESULT` events, which a page can render into a card of its own
 * as the dojo does, provided it reads the field names below.
 *
 * The tool shapes mirror `python/examples/server/api/backend_tool_rendering.py`
 * because the dojo's WeatherCard reads `location` from the call arguments and
 * `temperature` / `conditions` / `humidity` / `wind_speed` / `feels_like` from
 * the result. Renaming either side leaves the card showing no location and
 * every number at its zero default.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, listenOrExit, runIfMain } from "../run-if-main";

const CONDITIONS = ["sunny", "cloudy", "rainy", "clear", "partly cloudy"];

function randomInt(low: number, high: number): number {
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

export const getWeather = tool({
  name: "get_weather",
  description: "Get weather information for a location.",
  inputSchema: z.object({
    location: z.string().describe("The location to get weather for."),
  }),
  callback: () => ({
    temperature: randomInt(60, 85),
    conditions: CONDITIONS[randomInt(0, CONDITIONS.length - 1)],
    humidity: randomInt(30, 80),
    wind_speed: randomInt(5, 20),
    feels_like: randomInt(58, 88),
  }),
});

export const renderChart = tool({
  name: "render_chart",
  description: "Render a chart with backend processing capabilities.",
  inputSchema: z.object({
    chart_type: z.string().describe("Type of chart (bar, line, pie, etc.)"),
    data: z.string().describe("Chart data in JSON format"),
  }),
  callback: ({ chart_type, data }) => ({
    chart_type,
    data: data.slice(0, 100),
    status: "rendered",
  }),
});

const SYSTEM_PROMPT =
  "You are a helpful assistant with backend tool rendering capabilities. You can get weather information and render charts.";

export async function createBackendToolRenderingAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      model: await createModel(),
      systemPrompt: SYSTEM_PROMPT,
      tools: [getWeather, renderChart],
    }),
    name: "backend_tool_rendering",
    description:
      "Strands agent that invokes backend tools and renders the results in the UI",
  });
}

runIfMain(import.meta.url, async () => {
  // Port first: it throws on a malformed PORT, and building the agent first
  // would surface a missing API key instead and hide the real complaint.
  const port = demoPort();
  const app = await createStrandsApp(await createBackendToolRenderingAgent(), {
    path: "/",
  });
  listenOrExit(app, "backend-tool-rendering", port);
});
