/**
 * Utility functions for Claude Agent SDK adapter.
 *
 * Helper functions for message processing, tool conversion, and prompt building.
 */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { RunAgentInput, Tool, AssistantMessage, ToolCall, Message } from "@ag-ui/core";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  STATE_MANAGEMENT_TOOL_FULL_NAME,
} from "./config";

/**
 * Check if a state value is meaningful (non-null, non-undefined, non-empty object).
 *
 * In Python, `{}` is falsy so `if state:` naturally skips empty objects.
 * In JavaScript, `{}` is truthy, so we need an explicit check.
 * CopilotKit runtime sends `state: {}` even for agents that don't use useCoAgent.
 */
export function hasState(state: unknown): boolean {
  if (state == null) return false;
  if (typeof state !== "object") return true;
  if (Array.isArray(state)) return state.length > 0;
  // Empty objects ({}) count as "has state"
  return true;
}

/**
 * Extract tool names from AG-UI tool definitions.
 */
export function extractToolNames(tools: Tool[]): string[] {
  return tools.map((t) => t.name).filter(Boolean);
}

/**
 * Strip mcp__servername__ prefix from Claude SDK tool names.
 *
 * Claude SDK prefixes all MCP tools: mcp__weather__get_weather, mcp__ag_ui__generate_haiku
 * Frontend registers unprefixed: get_weather, generate_haiku
 *
 * @example
 * stripMcpPrefix("mcp__weather__get_weather") // "get_weather"
 * stripMcpPrefix("mcp__ag_ui__generate_haiku") // "generate_haiku"
 * stripMcpPrefix("local_tool") // "local_tool" (unchanged)
 */
export function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      // mcp__servername__toolname -- keep just toolname (handles double underscores in names)
      return parts.slice(2).join("__");
    }
  }
  return toolName;
}

/**
 * Result from processing messages.
 */
export type ProcessMessagesResult = {
  userMessage: string;
  hasPendingToolResult: boolean;
};

/**
 * Process and validate all messages from RunAgentInput.
 *
 * Similar to AWS Strands pattern: validates full message history even though
 * Claude SDK manages conversation via session_id.
 */
export function processMessages(input: RunAgentInput): ProcessMessagesResult {
  const messages = input.messages ?? [];

  // Check if last message is a tool result (for re-submission handling)
  let hasPendingToolResult = false;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "tool") {
      hasPendingToolResult = true;
      console.debug(
        `[ClaudeAdapter] Pending tool result detected: toolCallId=${(lastMsg as { toolCallId?: string }).toolCallId ?? "unknown"}, threadId=${input.threadId}`
      );
    }
  }

  // Log message counts for debugging
  console.debug(
    `[ClaudeAdapter] Processing ${messages.length} messages for threadId=${input.threadId}`
  );

  // Extract content from the LAST message (any role - user, tool, or assistant)
  // Claude SDK manages conversation history via session_id, we just need the latest input
  let userMessage = "";
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    const content = lastMsg.content;

    if (typeof content === "string") {
      userMessage = content;
    } else if (Array.isArray(content)) {
      // Content blocks format - extract text from first text block
      for (const block of content) {
        if (typeof block === "object" && block !== null && "text" in block) {
          userMessage = (block as { text: string }).text;
          break;
        }
      }
    }
  }

  if (!userMessage) {
    console.warn(
      `[ClaudeAdapter] No user message found in ${messages.length} messages`
    );
  }

  return { userMessage, hasPendingToolResult };
}

/**
 * Build state and context addendum for injection into the system prompt.
 *
 * Returns the formatted text block describing current state and application
 * context, or an empty string if neither is present.
 *
 * This keeps state/context in the system prompt (where it belongs) rather
 * than polluting the user message.
 */
export function buildStateContextAddendum(input: RunAgentInput): string {
  const parts: string[] = [];

  // Add context if provided
  if (input.context && input.context.length > 0) {
    parts.push("## Context from the application");
    for (const ctx of input.context) {
      parts.push(`- ${ctx.description}: ${ctx.value}`);
    }
    parts.push("");
  }

  // Add current state if provided (skip empty objects)
  if (hasState(input.state)) {
    parts.push("## Current Shared State");
    parts.push(
      "This state is shared with the frontend UI and can be updated."
    );
    try {
      const stateJson = JSON.stringify(input.state, null, 2);
      parts.push(`\`\`\`json\n${stateJson}\n\`\`\``);
    } catch {
      parts.push(`State: ${String(input.state)}`);
    }
    parts.push("");
    parts.push(
      "To update this state, use the `ag_ui_update_state` tool with your changes."
    );
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Convert a basic JSON Schema type string to a Zod type.
 * Falls back to z.any() for complex or unknown types.
 */
function jsonSchemaTypeToZod(
  prop: Record<string, unknown>
): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  let zodType: z.ZodTypeAny;

  switch (type) {
    case "string":
      zodType = prop.enum
        ? z.enum(prop.enum as [string, ...string[]])
        : z.string();
      break;
    case "number":
    case "integer":
      zodType = z.number();
      break;
    case "boolean":
      zodType = z.boolean();
      break;
    case "array":
      zodType = z.array(z.any());
      break;
    case "object":
      zodType = z.record(z.string(), z.any());
      break;
    default:
      zodType = z.any();
  }

  if (description) {
    zodType = zodType.describe(description);
  }

  return zodType;
}

/**
 * Convert a JSON Schema properties object to a Zod raw shape.
 * This is a pragmatic conversion for stub tools -- handles basic types
 * with z.any() fallback for complex nested schemas.
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown>
): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required ?? []) as string[];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonSchemaTypeToZod(prop);
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }
    shape[key] = zodType;
  }

  // If no properties were defined, use a catch-all
  if (Object.keys(shape).length === 0) {
    shape["args"] = z.any().optional().describe("Tool arguments");
  }

  return shape;
}

/**
 * Convert an AG-UI tool definition to a Claude SDK MCP tool.
 *
 * Creates a proxy tool that Claude can "see" and call, but with stub implementation
 * since actual execution happens on the client side.
 */
export function convertAguiToolToClaudeSdk(
  toolDef: Tool
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const toolName = toolDef.name ?? "unknown";
  const toolDescription = toolDef.description ?? "";
  const toolParameters = (toolDef.parameters ?? {}) as Record<string, unknown>;

  // Convert JSON Schema to Zod shape for the TS SDK's tool() function
  const zodShape = jsonSchemaToZodShape(toolParameters);

  // Create stub tool with empty implementation (execution happens client-side)
  return tool(toolName, toolDescription, zodShape, async () => ({
    content: [{ type: "text" as const, text: "Tool call forwarded to client" }],
  }));
}

/**
 * Create ag_ui_update_state tool for bidirectional state sync.
 *
 * This tool allows Claude to update the shared application state,
 * which is then emitted to the client via STATE_SNAPSHOT events.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createStateManagementTool(): any {
  return tool(
    "ag_ui_update_state",
    "Update the shared application state. Use this to persist changes that should be visible in the UI. Pass the complete updated state object.",
    { state_updates: z.record(z.string(), z.unknown()) },
    async () => ({
      content: [
        { type: "text" as const, text: "State updated successfully" },
      ],
    })
  );
}

/**
 * Apply forwardedProps as per-run Claude SDK option overrides.
 *
 * Only whitelisted keys are applied for security. forwardedProps enables
 * runtime control (model selection, limits, session control) without
 * changing agent identity or security boundaries.
 */
export function applyForwardedProps(
  forwardedProps: Record<string, unknown> | undefined,
  mergedOptions: Record<string, unknown>,
  allowedKeys: Set<string> = ALLOWED_FORWARDED_PROPS
): Record<string, unknown> {
  if (
    !forwardedProps ||
    typeof forwardedProps !== "object" ||
    Array.isArray(forwardedProps)
  ) {
    return mergedOptions;
  }

  let appliedCount = 0;
  for (const [key, value] of Object.entries(forwardedProps)) {
    if (allowedKeys.has(key) && value != null) {
      mergedOptions[key] = value;
      appliedCount++;
      console.debug(`[ClaudeAdapter] Applied forwarded_prop: ${key} = ${String(value)}`);
    } else if (!allowedKeys.has(key)) {
      console.warn(
        `[ClaudeAdapter] Ignoring non-whitelisted forwarded_prop: ${key}. See ALLOWED_FORWARDED_PROPS for supported keys.`
      );
    }
  }

  if (appliedCount > 0) {
    console.debug(
      `[ClaudeAdapter] Applied ${appliedCount} forwarded_props as option overrides`
    );
  }

  return mergedOptions;
}

/**
 * Check whether a tool name is the internal state management tool.
 */
export function isStateManagementTool(name: string): boolean {
  return (
    name === STATE_MANAGEMENT_TOOL_NAME ||
    name === STATE_MANAGEMENT_TOOL_FULL_NAME
  );
}

/**
 * Convert a complete Claude SDK AssistantMessage into an AG-UI AssistantMessage.
 *
 * Extracts text from TextBlocks and builds ToolCall objects from ToolUseBlocks.
 * Filters out internal state management tool calls and reasoning blocks since
 * they are not part of the user-visible conversation history.
 *
 * @returns AG-UI AssistantMessage, or null if the message has no user-visible content.
 */
export function buildAguiAssistantMessage(
  sdkMessage: SDKAssistantMessage,
  messageId: string
): AssistantMessage | null {
  const contentBlocks = sdkMessage.message?.content ?? [];

  let textContent = "";
  const toolCalls: ToolCall[] = [];

  for (const block of contentBlocks) {
    if (block.type === "text") {
      textContent += (block as { text: string }).text;
    } else if (block.type === "tool_use") {
      const toolBlock = block as BetaToolUseBlock;
      const rawName = toolBlock.name ?? "unknown";

      // Skip internal state management tool — not part of conversation history
      if (isStateManagementTool(rawName)) {
        continue;
      }

      toolCalls.push({
        id: toolBlock.id,
        type: "function" as const,
        function: {
          name: stripMcpPrefix(rawName),
          arguments: JSON.stringify(toolBlock.input ?? {}),
        },
        metadata: { rawName },
      });
    }
    // Reasoning/ThinkingBlocks are intentionally skipped — not conversation history
  }

  // Nothing user-visible (e.g. reasoning-only message)
  if (!textContent && toolCalls.length === 0) {
    return null;
  }

  const msg: AssistantMessage = {
    id: messageId,
    role: "assistant" as const,
  };

  if (textContent) {
    msg.content = textContent;
  }

  if (toolCalls.length > 0) {
    msg.toolCalls = toolCalls;
  }

  return msg;
}

/**
 * Build an AG-UI ToolMessage from a Claude SDK tool result block.
 *
 * Extracts the text content from the SDK's content block format and
 * normalises it into a simple string for the AG-UI message.
 */
export function buildAguiToolMessage(
  toolUseId: string,
  content: unknown
): Message {
  let resultStr = "";
  try {
    if (Array.isArray(content) && content.length > 0) {
      const firstBlock = content[0] as Record<string, unknown>;
      if (firstBlock?.type === "text") {
        const text = (firstBlock.text as string) ?? "";
        try {
          resultStr = JSON.stringify(JSON.parse(text));
        } catch {
          resultStr = text;
        }
      } else {
        resultStr = JSON.stringify(content);
      }
    } else if (content != null) {
      resultStr = JSON.stringify(content);
    }
  } catch {
    resultStr = String(content ?? "");
  }

  return {
    id: `${toolUseId}-result`,
    role: "tool" as const,
    content: resultStr,
    toolCallId: toolUseId,
  };
}
