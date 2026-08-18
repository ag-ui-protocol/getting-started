import { HttpAgent } from "@ag-ui/client";

export class CrewAIAgent extends HttpAgent {
  // CPK-7721: raised from "0.0.39" to above 0.0.47 so NONE of the three
  // backward-compat middlewares (BackwardCompatibility_0_0_39 / _0_0_45 /
  // _0_0_47) auto-insert. The 0.0.39 shim in particular stripped
  // ``parentRunId`` and FLATTENED array message content to text, destroying
  // multimodal input client-side. "0.0.57" matches the in-repo @ag-ui/core.
  public override get maxVersion(): string {
    return "0.0.57";
  }
}
