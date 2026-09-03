/**
 * AG-UI integration for CLI Agent Orchestrator (CAO).
 *
 * CAO (github.com/awslabs/cli-agent-orchestrator) runs each coding agent as a
 * real OS process in an isolated tmux session and coordinates them
 * supervisor -> worker over MCP. It exposes an AG-UI-compliant run plane
 * (`POST /agui/v1/run`) that emits official `ag-ui-protocol` `EventEncoder`
 * frames — a lifecycle-legal `RUN_STARTED -> STATE_SNAPSHOT -> ... ->
 * RUN_FINISHED` stream, including a genuine interrupt outcome
 * (`RUN_FINISHED outcome={type:"interrupt"}`) on a live permission prompt with
 * idempotent `resume[]` resolution.
 *
 * Because that surface is already stock AG-UI, this client is a *thin*
 * `HttpAgent` subclass with **zero extra wire code**: the stock `@ag-ui/client`
 * transport consumes CAO's stream directly. Any deviation here would fork the
 * contract that CAO already ships (awslabs/cli-agent-orchestrator#458).
 *
 * @see https://github.com/awslabs/cli-agent-orchestrator/blob/main/docs/agui.md
 */
import { HttpAgent } from "@ag-ui/client";

/**
 * AG-UI client for a CLI Agent Orchestrator run-plane endpoint.
 *
 * Point it at a CAO `POST /agui/v1/run` endpoint (or an example-server feature
 * route). No CAO-specific options are required or accepted beyond the standard
 * {@link HttpAgentConfig} — that is the whole point.
 *
 * @example
 * ```ts
 * import { CliAgentOrchestratorAgent } from "@ag-ui/cli-agent-orchestrator";
 *
 * const agent = new CliAgentOrchestratorAgent({
 *   url: "http://localhost:8027/agui/v1/run",
 * });
 * ```
 */
export class CliAgentOrchestratorAgent extends HttpAgent {}
