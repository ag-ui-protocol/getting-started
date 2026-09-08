import { EventType } from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

// Only CLIENT (frontend) tools stream their args live — the bridge learns them
// from RunAgentInput.tools. Register the tool names these fixtures use so they
// take the streaming path (server tools, absent here, are buffered instead).
const CLIENT_TOOLS = [
  { name: "get_weather", description: "d", parameters: {} },
  { name: "get_time", description: "d", parameters: {} },
];
const input = () => makeInput({ tools: CLIENT_TOOLS as any });

// Mastra-level chunk fixtures (what the bridge's createChunkProcessor consumes
// directly — shared by the local fullStream path and the remote
// processDataStream path).

function streamingChunks(
  toolCallId = "tc-1",
  toolName = "get_weather",
  argChunks = ['{"city":', '"NYC"}'],
) {
  return [
    {
      type: "tool-call-input-streaming-start",
      payload: { toolCallId, toolName },
    },
    ...argChunks.map((argsTextDelta) => ({
      type: "tool-call-delta",
      payload: { argsTextDelta, toolCallId, toolName },
    })),
    { type: "tool-call-input-streaming-end", payload: { toolCallId } },
    {
      type: "tool-call",
      payload: { toolCallId, toolName, args: { city: "NYC" } },
    },
  ];
}

function toolEvents(events: any[]) {
  return events.filter((e) =>
    [
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ].includes(e.type),
  );
}

describe("incremental tool-call args (chunk processor)", () => {
  describe.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ])("%s agent path", (_label, makeAgent) => {
    it("emits TOOL_CALL_START, one ARGS per delta, then TOOL_CALL_END", async () => {
      const agent = makeAgent({ streamChunks: streamingChunks() });
      const events = await collectEvents(agent, input());

      const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
      const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
      const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);

      expect(starts).toHaveLength(1);
      expect((starts[0] as any).toolCallName).toBe("get_weather");
      expect((starts[0] as any).toolCallId).toBe("tc-1");

      // One ARGS event per delta — args are NOT collapsed into one blob.
      expect(args).toHaveLength(2);
      expect((args as any[]).map((e) => e.delta)).toEqual([
        '{"city":',
        '"NYC"}',
      ]);
      expect((args as any[]).every((e) => e.toolCallId === "tc-1")).toBe(true);

      expect(ends).toHaveLength(1);

      // The trailing `tool-call` chunk must NOT re-emit args.
      const tool = toolEvents(events).map((e) => e.type);
      expect(tool).toEqual([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
      ]);
    });

    it("falls back to a single full-args ARGS when only a bare tool-call arrives", async () => {
      const agent = makeAgent({
        streamChunks: [
          {
            type: "tool-call",
            payload: {
              toolCallId: "tc-1",
              toolName: "get_weather",
              args: { city: "NYC" },
            },
          },
        ],
      });
      const events = await collectEvents(agent, input());

      const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
      expect(args).toHaveLength(1);
      expect(JSON.parse((args[0] as any).delta)).toEqual({ city: "NYC" });

      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(1);
    });

    it("emits a tool result after streamed args (no double START)", async () => {
      const agent = makeAgent({
        streamChunks: [
          ...streamingChunks(),
          {
            type: "tool-result",
            payload: { toolCallId: "tc-1", result: { temp: 72 } },
          },
        ],
      });
      const events = await collectEvents(agent, input());

      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(1);
      const results = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(results).toHaveLength(1);
      expect((results[0] as any).toolCallId).toBe("tc-1");
    });

    it("streams two tool calls independently", async () => {
      const agent = makeAgent({
        streamChunks: [
          ...streamingChunks("tc-1", "get_weather", ['{"city":', '"NYC"}']),
          ...streamingChunks("tc-2", "get_time", ['{"tz":', '"UTC"}']),
        ],
      });
      const events = await collectEvents(agent, input());

      const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
      expect((starts as any[]).map((e) => e.toolCallId)).toEqual([
        "tc-1",
        "tc-2",
      ]);

      const argsFor = (id: string) =>
        events.filter(
          (e) =>
            e.type === EventType.TOOL_CALL_ARGS && (e as any).toolCallId === id,
        );
      expect(argsFor("tc-1")).toHaveLength(2);
      expect(argsFor("tc-2")).toHaveLength(2);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(2);
    });

    it("closes the tool call even if the streaming-end chunk is absent", async () => {
      const agent = makeAgent({
        streamChunks: [
          {
            type: "tool-call-input-streaming-start",
            payload: { toolCallId: "tc-1", toolName: "get_weather" },
          },
          {
            type: "tool-call-delta",
            payload: { argsTextDelta: '{"city":"NYC"}', toolCallId: "tc-1" },
          },
          // no tool-call-input-streaming-end — the final tool-call must close it
          {
            type: "tool-call",
            payload: {
              toolCallId: "tc-1",
              toolName: "get_weather",
              args: { city: "NYC" },
            },
          },
        ],
      });
      const events = await collectEvents(agent, input());

      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_ARGS),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(1);
    });

    it("buffers a SERVER tool's streamed args (not a client tool) into one ARGS", async () => {
      // A tool that is NOT in RunAgentInput.tools is a server tool. Its delta
      // chunks must be ignored and the final tool-call buffered → a single
      // full-args ARGS. This keeps server tools suppressible by a following
      // tool-call-suspended / background-task-started (which reuse the buffered
      // args), the behavior that lets the background/interrupt paths work.
      const agent = makeAgent({
        streamChunks: streamingChunks("tc-9", "server_only_tool", [
          '{"q":',
          '"x"}',
        ]),
      });
      const events = await collectEvents(agent, input()); // input() has no server_only_tool

      const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
      expect(args).toHaveLength(1);
      expect((args[0] as any).toolCallId).toBe("tc-9");
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(1);
    });
  });
});
