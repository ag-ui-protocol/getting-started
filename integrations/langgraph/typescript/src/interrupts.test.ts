import { describe, it, expect } from "vitest";
import {
  langGraphInterruptToAGUI,
  langGraphInterruptsToAGUI,
  buildLgCommandResumeFromAgui,
  DEFAULT_RESUME_SENTINEL_CANCELLED,
  DEFAULT_RESUME_SENTINEL_MAP,
} from "./interrupts";
import type { ResumeEntry, Interrupt as AGUIInterrupt } from "@ag-ui/core";
import type { Interrupt as LangGraphInterrupt } from "@langchain/langgraph-sdk";
import { LangGraphAgent, LangGraphAgentConfig } from "./agent";

describe("langGraphInterruptToAGUI", () => {
  it("should map string value to message", () => {
    const result = langGraphInterruptToAGUI({ value: "confirm please", id: "int-1" });
    expect(result.message).toBe("confirm please");
    expect(result.reason).toBe("langgraph:interrupt");
    expect(result.id).toBe("int-1");
  });

  it("should use lg.id when present", () => {
    const result = langGraphInterruptToAGUI({
      value: "x",
      id: "int-42",
    });
    expect(result.id).toBe("int-42");
  });

  it("should throw when lg.id is missing", () => {
    expect(() => langGraphInterruptToAGUI({ value: "x" } as any)).toThrow(
      /missing `id`/,
    );
  });

  it("should extract reason from dict value", () => {
    const result = langGraphInterruptToAGUI({
      value: { reason: "confirm action" },
      id: "int-1",
    });
    expect(result.reason).toBe("confirm action");
  });

  it("should default reason to langgraph:interrupt when not in dict", () => {
    const result = langGraphInterruptToAGUI({ value: { foo: "bar" }, id: "int-1" });
    expect(result.reason).toBe("langgraph:interrupt");
  });

  it("should extract message from dict value", () => {
    const result = langGraphInterruptToAGUI({
      value: { message: "Please confirm" },
      id: "int-1",
    });
    expect(result.message).toBe("Please confirm");
  });

  it("should extract toolCallId from dict (camelCase)", () => {
    const result = langGraphInterruptToAGUI({
      value: { toolCallId: "tc1" },
      id: "int-1",
    });
    expect(result.toolCallId).toBe("tc1");
  });

  it("should extract tool_call_id from dict (snake_case)", () => {
    const result = langGraphInterruptToAGUI({
      value: { tool_call_id: "tc1" },
      id: "int-1",
    });
    expect(result.toolCallId).toBe("tc1");
  });

  it("should prefer camelCase toolCallId over snake_case", () => {
    const result = langGraphInterruptToAGUI({
      value: { toolCallId: "tc-camel", tool_call_id: "tc-snake" },
      id: "int-1",
    });
    expect(result.toolCallId).toBe("tc-camel");
  });

  it("should preserve empty-string toolCallId (?? semantics, not ||)", () => {
    const result = langGraphInterruptToAGUI({
      value: { toolCallId: "" },
      id: "int-1",
    });
    expect(result.toolCallId).toBe("");
  });

  it("should extract responseSchema from dict (camelCase)", () => {
    const schema = { type: "object", properties: { approved: { type: "boolean" } } };
    const result = langGraphInterruptToAGUI({
      value: { responseSchema: schema },
      id: "int-1",
    });
    expect(result.responseSchema).toEqual(schema);
  });

  it("should extract response_schema from dict (snake_case)", () => {
    const schema = { type: "string" };
    const result = langGraphInterruptToAGUI({
      value: { response_schema: schema },
      id: "int-1",
    });
    expect(result.responseSchema).toEqual(schema);
  });

  it("should preserve empty-object responseSchema", () => {
    const result = langGraphInterruptToAGUI({
      value: { responseSchema: {} },
      id: "int-1",
    });
    expect(result.responseSchema).toEqual({});
  });

  it("should extract expiresAt from dict (camelCase)", () => {
    const result = langGraphInterruptToAGUI({
      value: { expiresAt: "2026-12-31T23:59:59Z" },
      id: "int-1",
    });
    expect(result.expiresAt).toBe("2026-12-31T23:59:59Z");
  });

  it("should extract expires_at from dict (snake_case)", () => {
    const result = langGraphInterruptToAGUI({
      value: { expires_at: "2026-12-31T23:59:59Z" },
      id: "int-1",
    });
    expect(result.expiresAt).toBe("2026-12-31T23:59:59Z");
  });

  it("should set metadata.langgraph with raw, ns, resumable, when", () => {
    const lg = {
      value: { reason: "test" },
      id: "int-1",
      ns: ["node:abc"],
      resumable: true,
      when: "during",
    } as any;
    const result = langGraphInterruptToAGUI(lg);
    expect(result.metadata).toEqual({
      langgraph: {
        raw: { reason: "test" },
        ns: ["node:abc"],
        resumable: true,
        when: "during",
      },
    });
  });

  it("should not set optional fields when absent", () => {
    const result = langGraphInterruptToAGUI({ value: "simple", id: "int-1" });
    expect(result.toolCallId).toBeUndefined();
    expect(result.responseSchema).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });
});

describe("langGraphInterruptsToAGUI", () => {
  it("should map a list of interrupts", () => {
    const results = langGraphInterruptsToAGUI([
      { value: "a", id: "int-1" },
      { value: { reason: "b" }, id: "int-2" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].message).toBe("a");
    expect(results[1].reason).toBe("b");
  });

  it("should return empty array for empty input", () => {
    expect(langGraphInterruptsToAGUI([])).toHaveLength(0);
  });
});

describe("buildLgCommandResumeFromAgui", () => {
  it("should return payload directly for single resolved entry", () => {
    const entries: ResumeEntry[] = [
      { interruptId: "i1", status: "resolved", payload: { approved: true } },
    ];
    expect(buildLgCommandResumeFromAgui(entries)).toEqual({ approved: true });
  });

  it("should return payload as-is (not wrapped) for single resolved entry with primitive", () => {
    const entries: ResumeEntry[] = [
      { interruptId: "i1", status: "resolved", payload: "yes" },
    ];
    expect(buildLgCommandResumeFromAgui(entries)).toBe("yes");
  });

  it("should return cancelled sentinel for single cancelled entry", () => {
    const entries: ResumeEntry[] = [
      { interruptId: "i1", status: "cancelled" },
    ];
    const result = buildLgCommandResumeFromAgui(entries) as Record<string, unknown>;
    expect(result[DEFAULT_RESUME_SENTINEL_CANCELLED]).toBe(true);
    expect(result.interrupt_id).toBe("i1");
  });

  it("should return resume map sentinel for multiple entries", () => {
    const entries: ResumeEntry[] = [
      { interruptId: "i1", status: "resolved", payload: { ok: true } },
      { interruptId: "i2", status: "cancelled" },
    ];
    const result = buildLgCommandResumeFromAgui(entries) as Record<string, unknown>;
    const map = result[DEFAULT_RESUME_SENTINEL_MAP] as Record<string, unknown>;
    expect(map.i1).toEqual({ status: "resolved", payload: { ok: true } });
    expect(map.i2).toEqual({ status: "cancelled", payload: null });
  });

  it("should handle null payload as null in resume map", () => {
    const entries: ResumeEntry[] = [
      { interruptId: "i1", status: "resolved" },
    ];
    expect(buildLgCommandResumeFromAgui(entries)).toBeUndefined();
  });
});

describe("subclass hooks", () => {
  function makeAgent(): LangGraphAgent {
    const config: LangGraphAgentConfig = {
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
    };
    return new LangGraphAgent(config);
  }

  describe("default hook implementations match module-level functions", () => {
    it("interruptsToAGUI matches langGraphInterruptsToAGUI", () => {
      const agent = makeAgent() as any;
      const interrupts = [
        { value: "string value", id: "int-1" },
        { value: { reason: "r2", tool_call_id: "tc1" }, id: "int-2" },
      ] as LangGraphInterrupt[];

      const hookResult = agent.interruptsToAGUI(interrupts) as AGUIInterrupt[];
      const moduleResult = langGraphInterruptsToAGUI(interrupts);

      expect(hookResult).toHaveLength(moduleResult.length);
      for (let i = 0; i < hookResult.length; i++) {
        expect(hookResult[i].id).toBe(moduleResult[i].id);
        expect(hookResult[i].reason).toBe(moduleResult[i].reason);
        expect(hookResult[i].toolCallId).toBe(moduleResult[i].toolCallId);
      }
    });

    it("buildCommandResumeFromAgui single resolved returns payload verbatim (no sentinel)", () => {
      const agent = makeAgent() as any;
      const entries: ResumeEntry[] = [
        { interruptId: "i1", status: "resolved", payload: { approved: true } },
      ];
      const result = agent.buildCommandResumeFromAgui(entries, {
        openInterrupts: [],
      });
      expect(result).toEqual({ approved: true });
    });

    it("buildCommandResumeFromAgui single cancelled returns sentinel", () => {
      const agent = makeAgent() as any;
      const entries: ResumeEntry[] = [
        { interruptId: "i1", status: "cancelled" },
      ];
      const result = agent.buildCommandResumeFromAgui(entries, {
        openInterrupts: [],
      }) as Record<string, unknown>;
      expect(result[DEFAULT_RESUME_SENTINEL_CANCELLED]).toBe(true);
      expect(result.interrupt_id).toBe("i1");
    });

    it("buildCommandResumeFromAgui multiple entries returns resume map", () => {
      const agent = makeAgent() as any;
      const entries: ResumeEntry[] = [
        { interruptId: "i1", status: "resolved", payload: { a: 1 } },
        { interruptId: "i2", status: "cancelled" },
      ];
      const result = agent.buildCommandResumeFromAgui(entries, {
        openInterrupts: [],
      }) as Record<string, unknown>;
      const map = result[DEFAULT_RESUME_SENTINEL_MAP] as Record<string, unknown>;
      expect(map.i1).toEqual({ status: "resolved", payload: { a: 1 } });
      expect(map.i2).toEqual({ status: "cancelled", payload: null });
    });
  });

  describe("subclass fan-out", () => {
    class FanOutAgent extends LangGraphAgent {
      protected override interruptsToAGUI(
        list: readonly LangGraphInterrupt[],
      ): AGUIInterrupt[] {
        const out: AGUIInterrupt[] = [];
        for (const lg of list) {
          const value = lg.value;
          if (
            typeof value === "object" &&
            value !== null &&
            "action_requests" in (value as Record<string, unknown>)
          ) {
            const requests = (value as Record<string, unknown>)
              .action_requests as Array<Record<string, unknown>>;
            for (const req of requests) {
              out.push({
                id: `fan-${req.id ?? "unknown"}`,
                reason: (req.reason as string) ?? "langgraph:interrupt",
                message: req.message as string | undefined,
                metadata: { langgraph: { raw: value } },
              });
            }
          } else {
            out.push(langGraphInterruptToAGUI(lg));
          }
        }
        return out;
      }
    }

    it("vectorized interruptsToAGUI works with fan-out", () => {
      const agent = new FanOutAgent({
        graphId: "test-graph",
        deploymentUrl: "http://localhost:8000",
      }) as any;
      const interrupts = [
        {
          id: "int-1",
          value: {
            action_requests: [
              { id: "a1", reason: "approve A" },
              { id: "a2", reason: "approve B" },
            ],
          },
        },
        { id: "int-2", value: "simple" },
      ] as LangGraphInterrupt[];

      const result = agent.interruptsToAGUI(interrupts) as AGUIInterrupt[];
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("fan-a1");
      expect(result[1].id).toBe("fan-a2");
      expect(result[2].id).toBe("int-2");
    });

    it("falls back to default for non-action_requests interrupts", () => {
      const agent = new FanOutAgent({
        graphId: "test-graph",
        deploymentUrl: "http://localhost:8000",
      }) as any;
      const interrupts = [
        { id: "int-1", value: "simple string" },
      ] as LangGraphInterrupt[];
      const result = agent.interruptsToAGUI(interrupts) as AGUIInterrupt[];
      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe("langgraph:interrupt");
    });
  });

  describe("subclass resume hook override", () => {
    class CustomResumeAgent extends LangGraphAgent {
      protected override buildCommandResumeFromAgui(
        entries: readonly ResumeEntry[],
        _ctx: { openInterrupts: AGUIInterrupt[] },
      ): unknown {
        const decisions = entries.map((e) =>
          e.status === "resolved"
            ? { type: "approve", payload: e.payload }
            : { type: "reject", interrupt_id: e.interruptId },
        );
        return { decisions };
      }
    }

    it("subclass can produce framework-native resume shape", () => {
      const agent = new CustomResumeAgent({
        graphId: "test-graph",
        deploymentUrl: "http://localhost:8000",
      }) as any;
      const entries: ResumeEntry[] = [
        { interruptId: "i1", status: "resolved", payload: { ok: true } },
        { interruptId: "i2", status: "cancelled" },
      ];
      const result = agent.buildCommandResumeFromAgui(entries, {
        openInterrupts: [],
      }) as Record<string, unknown>;
      const decisions = result.decisions as Array<Record<string, unknown>>;
      expect(decisions).toHaveLength(2);
      expect(decisions[0].type).toBe("approve");
      expect(decisions[1].type).toBe("reject");
    });
  });
});
