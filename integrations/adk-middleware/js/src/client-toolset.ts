import type { Tool } from "@ag-ui/core";
import {
  BaseTool,
  BaseToolset,
  type ReadonlyContext,
  type RunAsyncToolRequest,
} from "@google/adk";

function bindingKey(userId: string, sessionId: string): string {
  return JSON.stringify([userId, sessionId]);
}

/**
 * A client-side tool declaration. ADK invokes it, receives no response, and
 * marks the call as long-running so the browser can execute it and resume the
 * session with a later function response.
 */
export class AGUIClientTool extends BaseTool {
  constructor(readonly tool: Tool) {
    super({
      name: tool.name,
      description: tool.description,
      isLongRunning: true,
    });
  }

  override _getDeclaration() {
    return {
      name: this.name,
      description: this.description,
      parametersJsonSchema: this.tool.parameters ?? {
        type: "object",
        properties: {},
      },
    };
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<undefined> {
    return undefined;
  }
}

/**
 * Construction-time placeholder for tools supplied in `RunAgentInput.tools`.
 *
 * Bindings are scoped by ADK user/session and are removed after every run. Its
 * `close()` is intentionally a no-op because `Runner.runAsync()` closes every
 * toolset after every invocation, while this placeholder belongs to the agent
 * configuration rather than to one invocation.
 */
export class AGUIClientToolset extends BaseToolset {
  private readonly bindings = new Map<string, Tool[]>();

  constructor() {
    super([]);
  }

  bindTools(userId: string, sessionId: string, tools: readonly Tool[]): void {
    this.bindings.set(bindingKey(userId, sessionId), [...tools]);
  }

  unbindTools(userId: string, sessionId: string): void {
    this.bindings.delete(bindingKey(userId, sessionId));
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!context) {
      return [];
    }
    const tools =
      this.bindings.get(bindingKey(context.userId, context.sessionId)) ?? [];
    return tools.map((tool) => new AGUIClientTool(tool));
  }

  override async close(): Promise<void> {
    // Runner closes toolsets after each run. Request bindings are owned and
    // cleaned up by ADKAgent's run lifecycle instead.
  }
}
