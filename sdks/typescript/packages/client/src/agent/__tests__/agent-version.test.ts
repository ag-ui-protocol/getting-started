import { AbstractAgent } from "@/agent";
import { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";
import packageJson from "../../../package.json";

describe("AbstractAgent maxVersion default", () => {
  class VersionAgent extends AbstractAgent {
    run(_input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.complete();
      });
    }
  }

  it("uses the package.json version by default", () => {
    const agent = new VersionAgent();
    expect(agent.maxVersion).toBe(packageJson.version);
  });
});
