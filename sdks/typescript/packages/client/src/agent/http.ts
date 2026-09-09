import { AbstractAgent, RunAgentResult } from "./agent";
import { runHttpRequest } from "@/run/http-request";
import { enforceOutgoingInput } from "@/enforce";
import { HttpAgentConfig, HttpAgentFetchFn, RunAgentParameters } from "./types";
import { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { structuredClone_ } from "@/utils";
import { transformHttpEventStream } from "@/transform/http";
import { Observable } from "rxjs";
import { AgentSubscriber } from "./subscriber";

interface RunHttpAgentConfig extends RunAgentParameters {
  abortController?: AbortController;
}

/**
 * The TERMINAL egress guard for the no-null attribution rule (PNI-199
 * alignment). prepareRunAgentInput sanitizes what it assembles, but middlewares
 * and in-place onRunInitialized mutations write to the input AFTER it — this is
 * the last point before the bytes leave, so it is where the rule must hold. A
 * null tag on the wire is schema-invalid and kills the whole run on the
 * receiving side; absent is the only spelling. Non-mutating: messages are
 * shallow-copied only when a strip is needed.
 */
function sanitizeOutgoingInput(input: RunAgentInput): RunAgentInput {
  if (!Array.isArray(input.messages)) return input;
  let changed = false;
  const messages = input.messages.map((message) => {
    if ((message as { subagentRunId?: string | null }).subagentRunId === null) {
      changed = true;
      // Spread + delete rather than rest-destructuring: Message is a union, and
      // rest types may only be created from object types under tsc.
      const copy = { ...message } as typeof message & { subagentRunId?: string | null };
      delete copy.subagentRunId;
      return copy as typeof message;
    }
    return message;
  });
  return changed ? { ...input, messages } : input;
}

export class HttpAgent extends AbstractAgent {
  public url: string;
  public headers: Record<string, string>;
  public fetch: HttpAgentFetchFn;
  public abortController: AbortController = new AbortController();

  /**
   * Returns the fetch config for the http request.
   * Override this to customize the request.
   *
   * @returns The fetch config for the http request.
   */
  protected requestInit(input: RunAgentInput): RequestInit {
    return {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(sanitizeOutgoingInput(input)),
      signal: this.abortController.signal,
    };
  }

  public runAgent(
    parameters?: RunHttpAgentConfig,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.abortController = parameters?.abortController ?? new AbortController();
    return super.runAgent(parameters, subscriber);
  }

  abortRun() {
    this.abortController.abort();
    super.abortRun();
  }

  constructor(config: HttpAgentConfig) {
    super(config);
    this.url = config.url;
    this.headers = structuredClone_(config.headers ?? {});
    // Bind the default fetch to the global object. Storing the bare `fetch`
    // and later invoking it as `this.fetch(...)` sets the receiver to the agent
    // instance; a browser's native fetch is a checked-receiver method and throws
    // "Illegal invocation" when not called with `window` as `this`. (Node's fetch
    // tolerates any receiver, so this only surfaces in the browser.)
    this.fetch = config.fetch ?? ((url, requestInit) => fetch(url, requestInit));
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    // The outgoing half of the enforcement boundary: checked immediately
    // before transmission. Inside the deferred request thunk — not during
    // pipeline construction, where a throw would escape the run's catchError
    // and leave lifecycle callbacks and the completion promise hanging — and
    // before requestInit, so a subclass overriding the request shape still
    // transmits enforced input. Unknown material is stripped with a warning;
    // a malformed known field fails the run before a byte leaves the process.
    const httpEvents = runHttpRequest(() =>
      this.fetch(this.url, this.requestInit(enforceOutgoingInput(input))),
    );
    return transformHttpEventStream(httpEvents, this.debugLogger);
  }

  public clone(): HttpAgent {
    const cloned = super.clone() as HttpAgent;
    cloned.url = this.url;
    cloned.headers = structuredClone_(this.headers ?? {});
    cloned.fetch = this.fetch;

    const newController = new AbortController();
    const originalSignal = this.abortController.signal as AbortSignal & { reason?: unknown };
    if (originalSignal.aborted) {
      newController.abort(originalSignal.reason);
    }
    cloned.abortController = newController;

    return cloned;
  }
}
