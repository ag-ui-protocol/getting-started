/**
 * The peer ceiling (`maxProtocolVersion`, and its deprecated alias
 * `maxVersion`) must preserve subclass overrides through both spellings.
 * Constructor version gates run before subclass instance fields exist.
 */
import { AbstractAgent } from "@/agent";
import { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import packageJson from "../../../package.json";

abstract class SilentAgent extends AbstractAgent {
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => subscriber.complete());
  }
}

function createPinnedAgent(name: "maxVersion" | "maxProtocolVersion", readPin: () => string) {
  class LegacyPinned extends SilentAgent {
    override get maxVersion(): string {
      return readPin();
    }
  }
  class ModernPinned extends SilentAgent {
    override get maxProtocolVersion(): string {
      return readPin();
    }
  }
  return name === "maxVersion" ? new LegacyPinned() : new ModernPinned();
}

describe("peer-ceiling getter compatibility", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it.each(["maxVersion", "maxProtocolVersion"] as const)(
    "evaluates a legacy override once when reading %s through super.maxVersion",
    (name) => {
      let reads = 0;
      class SuperSpelling extends SilentAgent {
        override get maxVersion(): string {
          reads++;
          return super.maxVersion;
        }
      }
      const agent = new SuperSpelling();
      reads = 0;

      expect(agent[name]).toBe(packageJson.version);
      expect(reads).toBe(1);
    },
  );

  it.each(["maxVersion", "maxProtocolVersion"] as const)(
    "evaluates a modern override once when reading %s through super.maxProtocolVersion",
    (name) => {
      let reads = 0;
      class SuperSpelling extends SilentAgent {
        override get maxProtocolVersion(): string {
          reads++;
          return super.maxProtocolVersion;
        }
      }
      const agent = new SuperSpelling();
      reads = 0;

      expect(agent[name]).toBe(packageJson.version);
      expect(reads).toBe(1);
    },
  );

  it.each(["maxVersion", "maxProtocolVersion"] as const)(
    "preserves an inherited legacy super chain when reading %s",
    (name) => {
      let parentReads = 0;
      let childReads = 0;
      class Parent extends SilentAgent {
        override get maxVersion(): string {
          parentReads++;
          return super.maxVersion;
        }
      }
      class Child extends Parent {
        override get maxVersion(): string {
          childReads++;
          return super.maxVersion;
        }
      }
      const agent = new Child();
      parentReads = childReads = 0;

      expect(agent[name]).toBe(packageJson.version);
      expect(parentReads).toBe(1);
      expect(childReads).toBe(1);
    },
  );

  it.each(["maxVersion", "maxProtocolVersion"] as const)(
    "terminates when reading %s from a legacy override that forwards to this.maxProtocolVersion",
    (name) => {
      class ThisSpelling extends SilentAgent {
        override get maxVersion(): string {
          return this.maxProtocolVersion;
        }
      }
      expect(new ThisSpelling()[name]).toBe(packageJson.version);
    },
  );

  it.each(["maxVersion", "maxProtocolVersion"] as const)(
    "keeps a %s pin live through both spellings",
    (name) => {
      let pin = "0.0.39";
      const agent = createPinnedAgent(name, () => pin);
      expect(agent.maxVersion).toBe(pin);
      expect(agent.maxProtocolVersion).toBe(pin);

      pin = "0.0.45";
      expect(agent.maxVersion).toBe(pin);
      expect(agent.maxProtocolVersion).toBe(pin);
    },
  );

  it.each(["maxVersion", "maxProtocolVersion"] as const)(
    "resolves a %s override again after it throws",
    (name) => {
      let failure: Error | undefined;
      const agent = createPinnedAgent(name, () => {
        if (failure) throw failure;
        return "0.0.39";
      });
      const alias = name === "maxVersion" ? "maxProtocolVersion" : "maxVersion";

      failure = new Error("ceiling lookup failed");
      expect(() => agent[alias]).toThrow(failure);
      failure = undefined;
      expect(agent[alias]).toBe("0.0.39");
    },
  );
});

describe("the constructor's peer-ceiling gates", () => {
  const unavailableCeiling = /maxProtocolVersion resolved to .* during construction/;

  it("names the defect when a maxVersion override reads an instance field", () => {
    // Field initialisers run AFTER super(), so the constructor's version gates
    // read `undefined` here. compareVersions then threw "Invalid argument
    // expected string", which named neither the field nor the getter.
    class FieldPinnedLegacy extends SilentAgent {
      private pin = "0.0.39";
      override get maxVersion(): string {
        return this.pin;
      }
    }
    expect(() => new FieldPinnedLegacy()).toThrow(unavailableCeiling);
  });

  it("names the defect when a maxProtocolVersion override reads an instance field", () => {
    class FieldPinnedModern extends SilentAgent {
      private pin = "0.0.39";
      override get maxProtocolVersion(): string {
        return this.pin;
      }
    }
    expect(() => new FieldPinnedModern()).toThrow(unavailableCeiling);
  });

  it("names the defect when the ceiling is not a comparable version", () => {
    class NotAVersion extends SilentAgent {
      override get maxProtocolVersion(): string {
        return "draft";
      }
    }
    expect(() => new NotAVersion()).toThrow(unavailableCeiling);
  });

  it("still installs the era shims for a literal ceiling", async () => {
    // "Does not throw" says nothing about the thing the title claims. The
    // gates exist to INSTALL shims, so the assertion has to be one of those
    // shims doing its job: BackwardCompatibility_0_0_39 flattens array message
    // content and strips parentRunId on the way out, because a 0.0.39 peer can
    // represent neither. A ceiling that failed to resolve to "0.0.39" would
    // install nothing and the array would arrive intact.
    class Literal extends SilentAgent {
      public receivedInput?: RunAgentInput;
      override get maxProtocolVersion(): string {
        return "0.0.39";
      }
      override run(input: RunAgentInput): Observable<BaseEvent> {
        this.receivedInput = input;
        return super.run(input);
      }
    }

    const agent = new Literal();
    agent.addMessage({
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "see: " },
        { type: "text", text: "this" },
      ],
    } as unknown as Message);

    await agent.runAgent({ runId: "ceiling-run" });

    expect(agent.receivedInput?.messages[0].content).toBe("see: this");
  });

  it("installs nothing when the ceiling is current", async () => {
    // The negative control for the gate above: without the pin the same
    // message keeps its parts, so the assertion above is about the SHIM and
    // not about something the pipeline does to every run.
    class Current extends SilentAgent {
      public receivedInput?: RunAgentInput;
      override run(input: RunAgentInput): Observable<BaseEvent> {
        this.receivedInput = input;
        return super.run(input);
      }
    }

    const agent = new Current();
    agent.addMessage({
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "see: " },
        { type: "text", text: "this" },
      ],
    } as unknown as Message);

    await agent.runAgent({ runId: "ceiling-run" });

    expect(Array.isArray(agent.receivedInput?.messages[0].content)).toBe(true);
  });
});
