// ── 2. Pure type import (should be untouched) ─────────────────────────────────
import type { Message, Tool, EventType } from "@ag-ui/core";

// ── 3. Mixed types and schemas ────────────────────────────────────────────────
import { Message as CoreMessage } from "@ag-ui/core";

// ── 4. Already-present @ag-ui/core/schemas import (new specifiers should merge) ─
import {
  BaseEventSchema,
  UserMessageSchema,
  EventSchemas,
  AgentCapabilitiesSchema,
  RunAgentInputSchema,
  RunAgentInputSchema as RunInput,
  RunAgentInputSchema as RunInputAlias,
  ContextSchema as Ctx,
  createTextMessageContentEvent,
  createRunStartedEvent,
  createRunErrorEvent,
} from "@ag-ui/core/schemas";

// ── 5. Non-schema import that must stay on @ag-ui/core ───────────────────────
import { EventType as ET } from "@ag-ui/core";

// ── 8. Namespace import — must be warned about and left untouched ─────────────
import * as core from "@ag-ui/core";

// ── 10. Pre-existing type-only schemas import + value import from @ag-ui/core ──
// The value spec must NOT be merged into the type-only declaration.
import type { BaseEventSchema as BaseEvent, ToolSchema, ContextSchema, StateSchema } from "@ag-ui/core/schemas";

// ── 12. Factory mixed with a type and the EventType enum (both stay) ─────────
import { EventType as EvType2, type BaseEvent as CoreBaseEvent } from "@ag-ui/core";

// ── Unrelated import — must not be touched ────────────────────────────────────
import { z } from "zod";

export function validate(raw: unknown) {
  return EventSchemas.safeParse(raw);
}

export function parseUser(raw: unknown) {
  return UserMessageSchema.safeParse(raw);
}

export function useMessage(msg: Message) {
  return msg;
}

export { CoreMessage };

// Case 7 usage — ensures RunInput alias is visible and would break if dropped
export function checkRunInput(raw: unknown) {
  return RunInput.safeParse(raw);
}

// Case 9 usage — both names must be usable after migration
export function checkRunInputAliased(raw: unknown) {
  return RunInputAlias.safeParse(raw);
}

// Case 10 usage — Ctx is a value import and must remain callable at runtime
export function checkCtx(raw: unknown) {
  return Ctx.safeParse(raw);
}

// Case 11/12 usage — factories must resolve from the subpath after migration
export function buildEvents() {
  const content = createTextMessageContentEvent({ messageId: "m1", delta: "hi" });
  const started = createRunStartedEvent({ threadId: "t1", runId: "r1" });
  const failed = createRunErrorEvent({ message: "boom" });
  const kind: typeof EvType2.RUN_ERROR = EvType2.RUN_ERROR;
  const base: CoreBaseEvent = content;
  return { content, started, failed, kind, base };
}
