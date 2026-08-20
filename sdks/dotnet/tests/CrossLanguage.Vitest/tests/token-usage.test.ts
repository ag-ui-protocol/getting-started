import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type TokenUsage } from "@ag-ui/core";
import { baseUrl } from "../helpers/dotnet-server";
import {
  TRANSPORTS,
  TRANSPORT_MEDIA_TYPE,
  createTransportAgent,
} from "../helpers/transport";

interface RunFinishedWithUsage extends BaseEvent {
  usage?: TokenUsage[];
}

// `usage` lives on RUN_FINISHED, which is in the protobuf-supported event set, so
// this suite runs over both transports. That is the point of it: the codec unit
// tests and the protobuf parity suite both exercise AGUIProtobuf in isolation,
// while this drives usage through real HTTP transport negotiation and the .NET
// protobuf *server* encoder, decoded by the real TypeScript client.
describe.each(TRANSPORTS)(
  "TS HttpAgent → C# AG-UI server (token usage) [%s]",
  (transport) => {
    async function run(threadId: string): Promise<BaseEvent[]> {
      const { agent, lastResponseContentType } = createTransportAgent(
        {
          url: `${baseUrl()}/token_usage`,
          threadId,
          agentId: "cross-language-usage",
        },
        transport,
      );
      agent.messages = [{ id: `u-${threadId}`, role: "user", content: "usage" }];

      const events: BaseEvent[] = [];
      await agent.runAgent({}, { onEvent: ({ event }) => void events.push(event) });

      // Guard against a silent fallback to SSE when protobuf was requested.
      expect(lastResponseContentType()).toBe(TRANSPORT_MEDIA_TYPE[transport]);
      return events;
    }

    function usageOf(events: BaseEvent[]): TokenUsage[] {
      const finished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as RunFinishedWithUsage | undefined;
      expect(finished).toBeDefined();
      return finished!.usage ?? [];
    }

    it("carries provider/model labels and accumulated counts", async () => {
      const usage = usageOf(await run(`usage-labels-${transport}`));

      expect(usage).toHaveLength(1);
      expect(usage[0].provider).toBe("usage-provider");
      expect(usage[0].model).toBe("usage-model");
    });

    it("sums counts across updates for the same (provider, model)", async () => {
      const usage = usageOf(await run(`usage-sum-${transport}`));

      // The route reports 10+5 input and 4+3 output across two updates.
      expect(usage[0].inputTokens).toBe(15);
      expect(usage[0].outputTokens).toBe(7);
      // Only the second update reported reasoning tokens.
      expect(usage[0].reasoningTokens).toBe(2);
    });

    it("keeps a reported zero distinct from an unreported count", async () => {
      const usage = usageOf(await run(`usage-zero-${transport}`));

      // Explicitly reported as 0 — must arrive as 0, not be dropped.
      expect(usage[0].cachedInputTokens).toBe(0);
      // Never reported by any update — must be absent rather than 0.
      expect(usage[0].totalTokens).toBeUndefined();
    });
  },
);
