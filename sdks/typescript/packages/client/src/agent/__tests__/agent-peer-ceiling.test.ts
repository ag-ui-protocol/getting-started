/**
 * The peer ceiling (`maxProtocolVersion`, and its deprecated alias
 * `maxVersion`) is read in two places that a subclass can break: the alias
 * cycle between the two getters, and the constructor's version gates, which
 * run before a subclass's instance fields exist.
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

describe("the maxVersion <-> maxProtocolVersion alias cycle", () => {
  it("terminates when a maxVersion override defers to super.maxVersion", () => {
    class SuperSpelling extends SilentAgent {
      override get maxVersion(): string {
        return super.maxVersion;
      }
    }
    expect(new SuperSpelling().maxProtocolVersion).toBe(packageJson.version);
  });

  it("terminates when a maxVersion override defers to this.maxProtocolVersion", () => {
    // The other spelling of the same deferral. The recursion guard only
    // covered `super.maxVersion`, so this one blew the stack.
    class ThisSpelling extends SilentAgent {
      override get maxVersion(): string {
        return this.maxProtocolVersion;
      }
    }
    expect(new ThisSpelling().maxProtocolVersion).toBe(packageJson.version);
  });

  it("clears the guard after a resolution, so a second read still resolves the override", () => {
    // What this proves: the flag is not left SET once a resolution finishes.
    // If it were, the second read would take the early-return branch at the
    // top of the getter and answer with the package default instead of the
    // override — which is why the expected value is the pin and not
    // `packageJson.version`.
    //
    // What it does NOT prove, and cannot: that `finally` RESTORES the previous
    // value rather than hard-setting `false`. The two are indistinguishable by
    // construction. The getter's first statement returns early whenever the
    // flag is already set, so the save/restore line is only ever reached with
    // the flag false — `wasResolving` can never be `true` there. A nested
    // resolution that would tell them apart is therefore not constructible
    // through the public surface, and an earlier version of this comment
    // claimed otherwise.
    class Pinned extends SilentAgent {
      override get maxVersion(): string {
        return "0.0.45";
      }
    }
    const agent = new Pinned();
    expect(agent.maxProtocolVersion).toBe("0.0.45");
    expect(agent.maxProtocolVersion).toBe("0.0.45");
    expect(agent.maxProtocolVersion).not.toBe(packageJson.version);
  });
});

describe("the constructor's peer-ceiling gates", () => {
  const unavailableCeiling =
    /maxProtocolVersion resolved to .* during construction/;

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
