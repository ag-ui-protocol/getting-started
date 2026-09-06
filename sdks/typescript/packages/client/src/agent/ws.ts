import { Observable } from "rxjs";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "./agent";
import { AgentConfig } from "./types";

export interface WebSocketAgentConfig extends AgentConfig {
  /** WebSocket URL of the AG-UI agent endpoint (e.g. "ws://localhost:8000/ws"). */
  url: string;
}

/**
 * AG-UI agent that communicates over a WebSocket connection instead of SSE.
 *
 * ## Wire format
 * - **Client → server**: one JSON frame containing the full `RunAgentInput`.
 * - **Server → client**: one JSON frame per AG-UI event, same schema as SSE.
 *
 * ## Why WebSocket?
 * Useful when SSE is impractical — e.g. behind proxies that buffer
 * long-lived HTTP/1.1 responses (Envoy, some API gateways) or environments
 * that require a prescribed WebSocket transport.
 *
 * WebSocket is also simpler for **HITL** flows: instead of opening a second
 * HTTP connection to resume after `RUN_FINISHED`, the client sends the
 * follow-up `RunAgentInput` (with the `ToolMessage` result) over the same
 * socket without reconnecting.
 *
 * @example
 * ```ts
 * const agent = new WebSocketAgent({
 *   url: "ws://localhost:8000/ws",
 *   threadId: crypto.randomUUID(),
 * });
 * await agent.runAgent({}, subscriber);
 * ```
 */
export class WebSocketAgent extends AbstractAgent {
  public url: string;

  constructor(config: WebSocketAgentConfig) {
    super(config);
    this.url = config.url;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let ws: WebSocket;
      let closed = false;

      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        subscriber.error(err);
        return;
      }

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(input));
        } catch (err) {
          subscriber.error(err);
        }
      };

      ws.onmessage = ({ data }) => {
        try {
          const event: BaseEvent =
            typeof data === "string" ? JSON.parse(data) : data;
          subscriber.next(event);

          if (
            event.type === EventType.RUN_FINISHED ||
            event.type === EventType.RUN_ERROR
          ) {
            closed = true;
            subscriber.complete();
            ws.close(1000);
          }
        } catch (err) {
          subscriber.error(err);
        }
      };

      ws.onerror = (event) => {
        subscriber.error(
          new Error(`WebSocket error: ${(event as ErrorEvent).message ?? "unknown"}`)
        );
      };

      ws.onclose = ({ code, reason, wasClean }) => {
        if (!closed) {
          if (wasClean) {
            subscriber.complete();
          } else {
            subscriber.error(
              new Error(
                `WebSocket closed unexpectedly (code=${code}${reason ? `, reason=${reason}` : ""})`
              )
            );
          }
        }
      };

      // Teardown: close the socket when the Observable is unsubscribed.
      return () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000);
        }
      };
    });
  }

  public clone(): WebSocketAgent {
    const cloned = super.clone() as WebSocketAgent;
    cloned.url = this.url;
    return cloned;
  }
}
