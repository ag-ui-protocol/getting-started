/**
 * Drift-prevention tests: assert that z.infer<typeof XxxSchema> (from
 * @ag-ui/core/schemas) exactly matches the hand-written types (from the
 * main @ag-ui/core entry). Any divergence between a schema and its
 * corresponding type will surface here as a compile error.
 *
 * Assertion strategy:
 * - Most types use `toEqualTypeOf` for strict bidirectional identity.
 *
 * - Event schemas extend `BaseEventSchema.passthrough()` which adds an index
 *   signature `[x: string]: unknown` to every inferred event type. This is
 *   intentional forward-compat behavior (unknown wire fields are preserved).
 *   The inferred type is a SUPERSET of the hand-written event type, so strict
 *   identity fails. We use `toExtend<HandWrittenEvent>()` on pre-evaluated
 *   type aliases — TypeScript must evaluate the complex generic before the
 *   constraint check, which is why the aliases are required.
 *
 * - Every `z.any()` used as an object value is explicitly `.optional()` in the
 *   schema, and the corresponding hand-written field is `?: any`. That covers
 *   `Tool.parameters`, `RunAgentInput.state`, `RunAgentInput.forwardedProps`,
 *   `StateSnapshotEvent.snapshot`, `RawEvent.event` and `CustomEvent.value`.
 *   The optionality is not cosmetic: a bare `z.any()` is accepted when missing
 *   on zod engine 4.0.x but rejected as `nonoptional` on 4.4.x, so leaving it
 *   implicit would make the wire contract depend on the consumer's zod version.
 *   See zod-version-conformance.test.ts.
 */
import { describe, it, expectTypeOf } from "vitest";
import { z } from "zod/v4";

// --------------------------------------------------------------------------
// Schema imports (from the schemas subpath module)
// --------------------------------------------------------------------------
import type {
  ToolCallSchema,
  FunctionCallSchema,
  MessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
  DeveloperMessageSchema,
  SystemMessageSchema,
  ToolSchema,
  ContextSchema,
  InterruptSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
  RoleSchema,
  InputContentSchema,
  BinaryInputContentSchema,
  // Event schemas
  BaseEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageChunkEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallChunkEventSchema,
  ToolCallResultEventSchema,
  StateSnapshotEventSchema,
  StateDeltaEventSchema,
  MessagesSnapshotEventSchema,
  ActivitySnapshotEventSchema,
  ActivityDeltaEventSchema,
  RawEventSchema,
  CustomEventSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunFinishedOutcomeSchema,
  RunFinishedSuccessOutcomeSchema,
  RunFinishedInterruptOutcomeSchema,
  RunErrorEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  ReasoningStartEventSchema,
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ReasoningMessageChunkEventSchema,
  ReasoningEndEventSchema,
  ReasoningEncryptedValueEventSchema,
  ThinkingStartEventSchema,
  ThinkingEndEventSchema,
  ThinkingTextMessageStartEventSchema,
  ThinkingTextMessageContentEventSchema,
  ThinkingTextMessageEndEventSchema,
  // Capability schemas
  SubAgentInfoSchema,
  IdentityCapabilitiesSchema,
  TransportCapabilitiesSchema,
  ToolsCapabilitiesSchema,
  OutputCapabilitiesSchema,
  StateCapabilitiesSchema,
  MultiAgentCapabilitiesSchema,
  ReasoningCapabilitiesSchema,
  MultimodalInputCapabilitiesSchema,
  MultimodalOutputCapabilitiesSchema,
  MultimodalCapabilitiesSchema,
  ExecutionCapabilitiesSchema,
  HumanInTheLoopCapabilitiesSchema,
  AgentCapabilitiesSchema,
} from "../schemas";

// --------------------------------------------------------------------------
// Type imports (from the canonical type modules)
// --------------------------------------------------------------------------
import type {
  ToolCall,
  FunctionCall,
  Message,
  AssistantMessage,
  UserMessage,
  ToolMessage,
  ActivityMessage,
  ReasoningMessage,
  DeveloperMessage,
  SystemMessage,
  Tool,
  Context,
  Interrupt,
  ResumeEntry,
  RunAgentInput,
  Role,
  InputContent,
  BinaryInputContent,
} from "../types";

import type {
  BaseEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  RawEvent,
  CustomEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunFinishedOutcome,
  RunFinishedSuccessOutcome,
  RunFinishedInterruptOutcome,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageChunkEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  ThinkingStartEvent,
  ThinkingEndEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
} from "../events";

import type {
  SubAgentInfo,
  IdentityCapabilities,
  TransportCapabilities,
  ToolsCapabilities,
  OutputCapabilities,
  StateCapabilities,
  MultiAgentCapabilities,
  ReasoningCapabilities,
  MultimodalInputCapabilities,
  MultimodalOutputCapabilities,
  MultimodalCapabilities,
  ExecutionCapabilities,
  HumanInTheLoopCapabilities,
  AgentCapabilities,
} from "../capabilities";

// --------------------------------------------------------------------------
// Helper: converts an interface to a mapped object type.
//
// TypeScript interfaces with no index signature cannot directly satisfy a type
// with `[x: string]: unknown` (which passthrough event schemas produce).
// Mapping through `{ [K in keyof T]: T[K] }` lifts the interface restriction
// so that the resulting object type CAN be used in `toExtend<_ISchema>()` calls.
// --------------------------------------------------------------------------
type AsObject<T> = { [K in keyof T]: T[K] };

// --------------------------------------------------------------------------
// Pre-evaluated type aliases for event schema inferences.
//
// `toExtend<z.infer<typeof XxxSchema>>()` fails because TypeScript does not
// fully evaluate the complex generic `objectOutputType<..., "passthrough">`
// inside the constraint check. Pre-defining aliases forces evaluation first.
// --------------------------------------------------------------------------
type _IBaseEvent = z.infer<typeof BaseEventSchema>;
type _ITextMessageStartEvent = z.infer<typeof TextMessageStartEventSchema>;
type _ITextMessageContentEvent = z.infer<typeof TextMessageContentEventSchema>;
type _ITextMessageEndEvent = z.infer<typeof TextMessageEndEventSchema>;
type _ITextMessageChunkEvent = z.infer<typeof TextMessageChunkEventSchema>;
type _IToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;
type _IToolCallArgsEvent = z.infer<typeof ToolCallArgsEventSchema>;
type _IToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;
type _IToolCallChunkEvent = z.infer<typeof ToolCallChunkEventSchema>;
type _IToolCallResultEvent = z.infer<typeof ToolCallResultEventSchema>;
type _IStateSnapshotEvent = z.infer<typeof StateSnapshotEventSchema>;
type _IStateDeltaEvent = z.infer<typeof StateDeltaEventSchema>;
type _IMessagesSnapshotEvent = z.infer<typeof MessagesSnapshotEventSchema>;
type _IActivitySnapshotEvent = z.infer<typeof ActivitySnapshotEventSchema>;
type _IActivityDeltaEvent = z.infer<typeof ActivityDeltaEventSchema>;
type _IRawEvent = z.infer<typeof RawEventSchema>;
type _ICustomEvent = z.infer<typeof CustomEventSchema>;
type _IRunStartedEvent = z.infer<typeof RunStartedEventSchema>;
type _IRunFinishedEvent = z.infer<typeof RunFinishedEventSchema>;
type _IRunErrorEvent = z.infer<typeof RunErrorEventSchema>;
type _IStepStartedEvent = z.infer<typeof StepStartedEventSchema>;
type _IStepFinishedEvent = z.infer<typeof StepFinishedEventSchema>;
type _IReasoningStartEvent = z.infer<typeof ReasoningStartEventSchema>;
type _IReasoningMessageStartEvent = z.infer<typeof ReasoningMessageStartEventSchema>;
type _IReasoningMessageContentEvent = z.infer<typeof ReasoningMessageContentEventSchema>;
type _IReasoningMessageEndEvent = z.infer<typeof ReasoningMessageEndEventSchema>;
type _IReasoningMessageChunkEvent = z.infer<typeof ReasoningMessageChunkEventSchema>;
type _IReasoningEndEvent = z.infer<typeof ReasoningEndEventSchema>;
type _IReasoningEncryptedValueEvent = z.infer<typeof ReasoningEncryptedValueEventSchema>;
type _IThinkingStartEvent = z.infer<typeof ThinkingStartEventSchema>;
type _IThinkingEndEvent = z.infer<typeof ThinkingEndEventSchema>;
type _IThinkingTextMessageStartEvent = z.infer<typeof ThinkingTextMessageStartEventSchema>;
type _IThinkingTextMessageContentEvent = z.infer<typeof ThinkingTextMessageContentEventSchema>;
type _IThinkingTextMessageEndEvent = z.infer<typeof ThinkingTextMessageEndEventSchema>;

// ==========================================================================
// Types tests
// ==========================================================================

describe("schema inferred types match hand-written types (types.ts)", () => {
  it("ToolCall", () => {
    expectTypeOf<z.infer<typeof ToolCallSchema>>().toEqualTypeOf<ToolCall>();
  });
  it("FunctionCall", () => {
    expectTypeOf<z.infer<typeof FunctionCallSchema>>().toEqualTypeOf<FunctionCall>();
  });
  it("Message", () => {
    expectTypeOf<z.infer<typeof MessageSchema>>().toEqualTypeOf<Message>();
  });
  it("AssistantMessage", () => {
    expectTypeOf<z.infer<typeof AssistantMessageSchema>>().toEqualTypeOf<AssistantMessage>();
  });
  it("UserMessage", () => {
    expectTypeOf<z.infer<typeof UserMessageSchema>>().toEqualTypeOf<UserMessage>();
  });
  it("ToolMessage", () => {
    expectTypeOf<z.infer<typeof ToolMessageSchema>>().toEqualTypeOf<ToolMessage>();
  });
  it("ActivityMessage", () => {
    expectTypeOf<z.infer<typeof ActivityMessageSchema>>().toEqualTypeOf<ActivityMessage>();
  });
  it("ReasoningMessage", () => {
    expectTypeOf<z.infer<typeof ReasoningMessageSchema>>().toEqualTypeOf<ReasoningMessage>();
  });
  it("DeveloperMessage", () => {
    expectTypeOf<z.infer<typeof DeveloperMessageSchema>>().toEqualTypeOf<DeveloperMessage>();
  });
  it("SystemMessage", () => {
    expectTypeOf<z.infer<typeof SystemMessageSchema>>().toEqualTypeOf<SystemMessage>();
  });
  it("Tool", () => {
    expectTypeOf<z.infer<typeof ToolSchema>>().toEqualTypeOf<Tool>();
  });
  it("Context", () => {
    expectTypeOf<z.infer<typeof ContextSchema>>().toEqualTypeOf<Context>();
  });
  it("Interrupt", () => {
    expectTypeOf<z.infer<typeof InterruptSchema>>().toEqualTypeOf<Interrupt>();
  });
  it("ResumeEntry", () => {
    expectTypeOf<z.infer<typeof ResumeEntrySchema>>().toEqualTypeOf<ResumeEntry>();
  });
  it("RunAgentInput", () => {
    expectTypeOf<z.infer<typeof RunAgentInputSchema>>().toEqualTypeOf<RunAgentInput>();
  });
  it("Role", () => {
    expectTypeOf<z.infer<typeof RoleSchema>>().toEqualTypeOf<Role>();
  });
  it("InputContent", () => {
    expectTypeOf<z.infer<typeof InputContentSchema>>().toEqualTypeOf<InputContent>();
  });
  it("BinaryInputContent", () => {
    expectTypeOf<z.infer<typeof BinaryInputContentSchema>>().toEqualTypeOf<BinaryInputContent>();
  });
});

// ==========================================================================
// Event tests
// ==========================================================================

describe("schema inferred types match hand-written types (events.ts)", () => {
  // All event schemas extend BaseEventSchema.passthrough(), which adds
  // [x: string]: unknown to z.infer<...>. This is intentional (forward-compat).
  // Strict equality fails; we verify the schema-inferred type extends the
  // hand-written type (the schema accepts everything the hand-written type
  // represents, plus possibly extra wire fields).
  // Type aliases are required — see module-level comment above.
  it("BaseEvent", () => {
    // BaseEventSchema uses z.enum([...]) with plain string literals for `type`,
    // which infers as `"TEXT_MESSAGE_START" | ...` (string literal union). The
    // hand-written BaseEvent has `type: EventType` (a TypeScript string enum).
    // String literals do NOT extend enum types in TypeScript's type system, so
    // the forward check `_IBaseEvent extends BaseEvent` fails.
    //
    // Enum members DO extend their corresponding string literals, so the reverse
    // `BaseEvent extends _IBaseEvent` would pass for `type` — but TypeScript
    // interfaces cannot satisfy index-signature types (`[x: string]: unknown`).
    // `AsObject<T>` converts the interface to a mapped type, removing that
    // restriction.
    expectTypeOf<AsObject<BaseEvent>>().toExtend<_IBaseEvent>();
  });
  it("TextMessageStartEvent", () => {
    expectTypeOf<_ITextMessageStartEvent>().toExtend<TextMessageStartEvent>();
  });
  it("TextMessageContentEvent", () => {
    expectTypeOf<_ITextMessageContentEvent>().toExtend<TextMessageContentEvent>();
  });
  it("TextMessageEndEvent", () => {
    expectTypeOf<_ITextMessageEndEvent>().toExtend<TextMessageEndEvent>();
  });
  it("TextMessageChunkEvent", () => {
    expectTypeOf<_ITextMessageChunkEvent>().toExtend<TextMessageChunkEvent>();
  });
  it("ToolCallStartEvent", () => {
    expectTypeOf<_IToolCallStartEvent>().toExtend<ToolCallStartEvent>();
  });
  it("ToolCallArgsEvent", () => {
    expectTypeOf<_IToolCallArgsEvent>().toExtend<ToolCallArgsEvent>();
  });
  it("ToolCallEndEvent", () => {
    expectTypeOf<_IToolCallEndEvent>().toExtend<ToolCallEndEvent>();
  });
  it("ToolCallChunkEvent", () => {
    expectTypeOf<_IToolCallChunkEvent>().toExtend<ToolCallChunkEvent>();
  });
  it("ToolCallResultEvent", () => {
    expectTypeOf<_IToolCallResultEvent>().toExtend<ToolCallResultEvent>();
  });
  it("StateSnapshotEvent", () => {
    // `snapshot: StateSchema` where `StateSchema = z.any()`. Zod 3's
    // addQuestionMarks makes required `z.any()` fields optional in the inferred
    // type (`snapshot?: any`). The hand-written type has `snapshot: any`
    // (required). Required satisfies optional, so the reverse check passes.
    expectTypeOf<AsObject<StateSnapshotEvent>>().toExtend<_IStateSnapshotEvent>();
  });
  it("StateDeltaEvent", () => {
    expectTypeOf<_IStateDeltaEvent>().toExtend<StateDeltaEvent>();
  });
  it("MessagesSnapshotEvent", () => {
    expectTypeOf<_IMessagesSnapshotEvent>().toExtend<MessagesSnapshotEvent>();
  });
  it("ActivitySnapshotEvent", () => {
    expectTypeOf<_IActivitySnapshotEvent>().toExtend<ActivitySnapshotEvent>();
  });
  it("ActivityDeltaEvent", () => {
    expectTypeOf<_IActivityDeltaEvent>().toExtend<ActivityDeltaEvent>();
  });
  it("RawEvent", () => {
    // `event: z.any()` — same addQuestionMarks quirk as StateSnapshotEvent above.
    expectTypeOf<AsObject<RawEvent>>().toExtend<_IRawEvent>();
  });
  it("CustomEvent", () => {
    // `value: z.any()` — same addQuestionMarks quirk as StateSnapshotEvent above.
    expectTypeOf<AsObject<CustomEvent>>().toExtend<_ICustomEvent>();
  });
  it("RunStartedEvent", () => {
    // `input?: RunAgentInputSchema` — RunAgentInput has `state: any` and
    // `forwardedProps: any` which become optional in the inferred type (same
    // addQuestionMarks quirk). Reverse direction handles this.
    expectTypeOf<AsObject<RunStartedEvent>>().toExtend<_IRunStartedEvent>();
  });
  it("RunFinishedEvent", () => {
    expectTypeOf<_IRunFinishedEvent>().toExtend<RunFinishedEvent>();
  });
  it("RunFinishedOutcome", () => {
    // Outcome schemas use .strict() without passthrough; strict equality holds.
    expectTypeOf<z.infer<typeof RunFinishedOutcomeSchema>>().toEqualTypeOf<RunFinishedOutcome>();
  });
  it("RunFinishedSuccessOutcome", () => {
    expectTypeOf<z.infer<typeof RunFinishedSuccessOutcomeSchema>>().toEqualTypeOf<RunFinishedSuccessOutcome>();
  });
  it("RunFinishedInterruptOutcome", () => {
    expectTypeOf<z.infer<typeof RunFinishedInterruptOutcomeSchema>>().toEqualTypeOf<RunFinishedInterruptOutcome>();
  });
  it("RunErrorEvent", () => {
    expectTypeOf<_IRunErrorEvent>().toExtend<RunErrorEvent>();
  });
  it("StepStartedEvent", () => {
    expectTypeOf<_IStepStartedEvent>().toExtend<StepStartedEvent>();
  });
  it("StepFinishedEvent", () => {
    expectTypeOf<_IStepFinishedEvent>().toExtend<StepFinishedEvent>();
  });
  it("ReasoningStartEvent", () => {
    expectTypeOf<_IReasoningStartEvent>().toExtend<ReasoningStartEvent>();
  });
  it("ReasoningMessageStartEvent", () => {
    expectTypeOf<_IReasoningMessageStartEvent>().toExtend<ReasoningMessageStartEvent>();
  });
  it("ReasoningMessageContentEvent", () => {
    expectTypeOf<_IReasoningMessageContentEvent>().toExtend<ReasoningMessageContentEvent>();
  });
  it("ReasoningMessageEndEvent", () => {
    expectTypeOf<_IReasoningMessageEndEvent>().toExtend<ReasoningMessageEndEvent>();
  });
  it("ReasoningMessageChunkEvent", () => {
    expectTypeOf<_IReasoningMessageChunkEvent>().toExtend<ReasoningMessageChunkEvent>();
  });
  it("ReasoningEndEvent", () => {
    expectTypeOf<_IReasoningEndEvent>().toExtend<ReasoningEndEvent>();
  });
  it("ReasoningEncryptedValueEvent", () => {
    expectTypeOf<_IReasoningEncryptedValueEvent>().toExtend<ReasoningEncryptedValueEvent>();
  });
  it("ThinkingStartEvent", () => {
    expectTypeOf<_IThinkingStartEvent>().toExtend<ThinkingStartEvent>();
  });
  it("ThinkingEndEvent", () => {
    expectTypeOf<_IThinkingEndEvent>().toExtend<ThinkingEndEvent>();
  });
  it("ThinkingTextMessageStartEvent", () => {
    expectTypeOf<_IThinkingTextMessageStartEvent>().toExtend<ThinkingTextMessageStartEvent>();
  });
  it("ThinkingTextMessageContentEvent", () => {
    expectTypeOf<_IThinkingTextMessageContentEvent>().toExtend<ThinkingTextMessageContentEvent>();
  });
  it("ThinkingTextMessageEndEvent", () => {
    expectTypeOf<_IThinkingTextMessageEndEvent>().toExtend<ThinkingTextMessageEndEvent>();
  });
});

// ==========================================================================
// Capability tests
// ==========================================================================

describe("schema inferred types match hand-written types (capabilities.ts)", () => {
  it("SubAgentInfo", () => {
    expectTypeOf<z.infer<typeof SubAgentInfoSchema>>().toEqualTypeOf<SubAgentInfo>();
  });
  it("IdentityCapabilities", () => {
    expectTypeOf<z.infer<typeof IdentityCapabilitiesSchema>>().toEqualTypeOf<IdentityCapabilities>();
  });
  it("TransportCapabilities", () => {
    expectTypeOf<z.infer<typeof TransportCapabilitiesSchema>>().toEqualTypeOf<TransportCapabilities>();
  });
  it("ToolsCapabilities", () => {
    expectTypeOf<z.infer<typeof ToolsCapabilitiesSchema>>().toEqualTypeOf<ToolsCapabilities>();
  });
  it("OutputCapabilities", () => {
    expectTypeOf<z.infer<typeof OutputCapabilitiesSchema>>().toEqualTypeOf<OutputCapabilities>();
  });
  it("StateCapabilities", () => {
    expectTypeOf<z.infer<typeof StateCapabilitiesSchema>>().toEqualTypeOf<StateCapabilities>();
  });
  it("MultiAgentCapabilities", () => {
    expectTypeOf<z.infer<typeof MultiAgentCapabilitiesSchema>>().toEqualTypeOf<MultiAgentCapabilities>();
  });
  it("ReasoningCapabilities", () => {
    expectTypeOf<z.infer<typeof ReasoningCapabilitiesSchema>>().toEqualTypeOf<ReasoningCapabilities>();
  });
  it("MultimodalInputCapabilities", () => {
    expectTypeOf<z.infer<typeof MultimodalInputCapabilitiesSchema>>().toEqualTypeOf<MultimodalInputCapabilities>();
  });
  it("MultimodalOutputCapabilities", () => {
    expectTypeOf<z.infer<typeof MultimodalOutputCapabilitiesSchema>>().toEqualTypeOf<MultimodalOutputCapabilities>();
  });
  it("MultimodalCapabilities", () => {
    expectTypeOf<z.infer<typeof MultimodalCapabilitiesSchema>>().toEqualTypeOf<MultimodalCapabilities>();
  });
  it("ExecutionCapabilities", () => {
    expectTypeOf<z.infer<typeof ExecutionCapabilitiesSchema>>().toEqualTypeOf<ExecutionCapabilities>();
  });
  it("HumanInTheLoopCapabilities", () => {
    expectTypeOf<z.infer<typeof HumanInTheLoopCapabilitiesSchema>>().toEqualTypeOf<HumanInTheLoopCapabilities>();
  });
  it("AgentCapabilities", () => {
    expectTypeOf<z.infer<typeof AgentCapabilitiesSchema>>().toEqualTypeOf<AgentCapabilities>();
  });
});
