import { of, Observable } from "rxjs";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { PROTOCOL_VERSION } from "@ag-ui/core";
import { AbstractAgent, WIRE_PROTOCOL_VERSION, compareDeclaredProtocol } from "../agent";
import packageJson from "../../../package.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class StubAgent extends AbstractAgent {
  public lastInput?: RunAgentInput;
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.lastInput = input;
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
    );
  }
}

class PinnedAgent extends StubAgent {
  // The pre-rename spelling an integration may still override.
  override get maxVersion(): string {
    return "0.0.57";
  }
}

describe("the in-band protocol version", () => {
  it("declares the wire protocol version on the input it builds", async () => {
    const agent = new StubAgent();
    await agent.runAgent();
    expect(agent.lastInput?.protocolVersion).toBe(WIRE_PROTOCOL_VERSION);
  });

  it("omits the declaration when the peer's ceiling is pinned below this client", async () => {
    const agent = new PinnedAgent();
    await agent.runAgent();
    expect(agent.lastInput).toBeDefined();
    expect("protocolVersion" in (agent.lastInput as object)).toBe(false);
  });

  describe("the RUN_STARTED echo", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    const runWithEcho = async (declared?: string) => {
      class EchoAgent extends StubAgent {
        run(input: RunAgentInput): Observable<BaseEvent> {
          return of(
            {
              type: EventType.RUN_STARTED,
              threadId: input.threadId,
              runId: input.runId,
              ...(declared !== undefined && { protocolVersion: declared }),
            } as BaseEvent,
            {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent,
          );
        }
      }
      await new EchoAgent().runAgent();
    };

    it("warns when the producer declares a newer protocol", async () => {
      await runWithEcho("1.1");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("speaks protocol 1.1"));
    });

    it("stays quiet on the same version, an older one, or none", async () => {
      await runWithEcho(WIRE_PROTOCOL_VERSION);
      await runWithEcho("0.9");
      await runWithEcho(undefined);
      const protocolWarnings = warn.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes("speaks protocol"),
      );
      expect(protocolWarnings).toHaveLength(0);
    });

    it("warns when the declared version cannot be interpreted", async () => {
      await runWithEcho("draft");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot interpret"));
    });

    it("treats near-misses of the published grammar as uninterpretable", async () => {
      // compareVersions would read all three as equal to 1.0; the grammar
      // check is what keeps them in the cannot-interpret branch.
      for (const declared of ["1", "1.0.0", "1.x"]) {
        warn.mockClear();
        await runWithEcho(declared);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot interpret"));
      }
    });

    it("warns through the comparator on a newer declaration", async () => {
      await runWithEcho("1.10");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("speaks protocol 1.10"));
    });
  });

  describe("the declared-protocol comparator", () => {
    it("compares components numerically, not lexicographically", () => {
      // The pair that tells the two orderings apart: as strings "1.10" < "1.9".
      expect(compareDeclaredProtocol("1.10", "1.9")).toBe("newer");
      expect(compareDeclaredProtocol("1.9", "1.10")).toBe("not-newer");
    });

    it("rejects everything outside the published two-component grammar", () => {
      for (const declared of ["1", "1.0.0", "1.x", "draft", "v1.0"]) {
        expect(compareDeclaredProtocol(declared, "1.0")).toBe("uninterpretable");
      }
    });
  });
});

describe("maxProtocolVersion", () => {
  it("is the package version by default and equals the deprecated alias", () => {
    const agent = new StubAgent();
    expect(agent.maxProtocolVersion).toBe(packageJson.version);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(agent.maxVersion).toBe(agent.maxProtocolVersion);
    // Deprecation warns once per process; this file's first plain read is here.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("maxVersion is deprecated"));
    warn.mockRestore();
  });

  it("honors a subclass that still overrides the deprecated name", () => {
    expect(new PinnedAgent().maxProtocolVersion).toBe("0.0.57");
  });

  it("is not the generated protocol constant — a peer ceiling, not a spec revision", () => {
    // PNI-211's whole point: two version values, distinguishable on sight.
    expect(new StubAgent().maxProtocolVersion).not.toBe(PROTOCOL_VERSION);
  });
});

describe("the deprecated alias cycle guard", () => {
  it("survives an override that defers to super.maxVersion", () => {
    class DeferringAgent extends AbstractAgent {
      run(): Observable<BaseEvent> {
        return of();
      }
      override get maxVersion(): string {
        return super.maxVersion;
      }
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(new DeferringAgent().maxProtocolVersion).toBe(packageJson.version);
    warn.mockRestore();
  });
});
