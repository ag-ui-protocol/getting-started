import { z } from "zod";
import { OptionalMetadataSchema } from "./metadata";

export const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: FunctionCallSchema,
  encryptedValue: z.string().optional(),
  // A tool call is not a message, so it carries its own metadata rather than
  // folding into the assistant message that owns it. Several tool calls can
  // share one parent, and merging them all into it would make the result depend
  // on their relative order — which stream transforms like `compactEvents` are
  // free to change.
  metadata: OptionalMetadataSchema,
});

export const BaseMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().optional(),
  name: z.string().optional(),
  encryptedValue: z.string().optional(),
  subagentRunId: z.string().optional(),
  metadata: OptionalMetadataSchema,
});

export const TextInputContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const InputContentDataSourceSchema = z.object({
  type: z.literal("data"),
  value: z.string(),
  mimeType: z.string(),
});

export const InputContentUrlSourceSchema = z.object({
  type: z.literal("url"),
  value: z.string(),
  mimeType: z.string().optional(),
});

export const InputContentSourceSchema = z.discriminatedUnion("type", [
  InputContentDataSourceSchema,
  InputContentUrlSourceSchema,
]);

export const ImageInputContentSchema = z.object({
  type: z.literal("image"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const AudioInputContentSchema = z.object({
  type: z.literal("audio"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const VideoInputContentSchema = z.object({
  type: z.literal("video"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const DocumentInputContentSchema = z.object({
  type: z.literal("document"),
  source: InputContentSourceSchema,
  metadata: z.unknown().optional(),
});

export const ImageInputPartSchema = ImageInputContentSchema;
export const AudioInputPartSchema = AudioInputContentSchema;
export const VideoInputPartSchema = VideoInputContentSchema;
export const DocumentInputPartSchema = DocumentInputContentSchema;

const LegacyBinaryInputContentObjectSchema = z.object({
  type: z.literal("binary"),
  mimeType: z.string(),
  id: z.string().optional(),
  url: z.string().optional(),
  data: z.string().optional(),
  filename: z.string().optional(),
});

const ensureBinaryPayload = (
  value: { id?: string; url?: string; data?: string },
  ctx: z.RefinementCtx,
) => {
  if (!value.id && !value.url && !value.data) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BinaryInputContent requires at least one of id, url, or data.",
      path: ["id"],
    });
  }
};

export const BinaryInputContentSchema = LegacyBinaryInputContentObjectSchema.superRefine(
  (value, ctx) => {
    ensureBinaryPayload(value, ctx);
  },
);

const InputContentBaseSchema = z.discriminatedUnion("type", [
  TextInputContentSchema,
  ImageInputContentSchema,
  AudioInputContentSchema,
  VideoInputContentSchema,
  DocumentInputContentSchema,
  LegacyBinaryInputContentObjectSchema,
]);

export const InputContentSchema = InputContentBaseSchema.superRefine((value, ctx) => {
  if (value.type === "binary") {
    ensureBinaryPayload(value, ctx);
  }
});

export const DeveloperMessageSchema = BaseMessageSchema.extend({
  role: z.literal("developer"),
  content: z.string(),
});

export const SystemMessageSchema = BaseMessageSchema.extend({
  role: z.literal("system"),
  content: z.string(),
});

export const AssistantMessageSchema = BaseMessageSchema.extend({
  role: z.literal("assistant"),
  content: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export const UserMessageSchema = BaseMessageSchema.extend({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(InputContentSchema)]),
});

// The three schemas below stand alone rather than extending BaseMessageSchema,
// so each declares `metadata` itself.
export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
  name: z.string().optional(),
  error: z.string().optional(),
  encryptedValue: z.string().optional(),
  subagentRunId: z.string().optional(),
  metadata: OptionalMetadataSchema,
});

export const ActivityMessageSchema = z.object({
  id: z.string(),
  role: z.literal("activity"),
  activityType: z.string(),
  content: z.record(z.any()),
  subagentRunId: z.string().optional(),
  metadata: OptionalMetadataSchema,
});

export const ReasoningMessageSchema = z.object({
  id: z.string(),
  role: z.literal("reasoning"),
  content: z.string(),
  encryptedValue: z.string().optional(),
  subagentRunId: z.string().optional(),
  metadata: OptionalMetadataSchema,
});

export const MessageSchema = z.discriminatedUnion("role", [
  DeveloperMessageSchema,
  SystemMessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
]);

export const RoleSchema = z.union([
  z.literal("developer"),
  z.literal("system"),
  z.literal("assistant"),
  z.literal("user"),
  z.literal("tool"),
  z.literal("activity"),
  z.literal("reasoning"),
]);

export const ContextSchema = z.object({
  description: z.string(),
  value: z.string(),
});

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.any(), // JSON Schema for the tool parameters
  metadata: z.record(z.any()).optional(), // Arbitrary tool metadata (e.g. a2ui schema)
});

export const InterruptSchema = z.object({
  id: z.string(),
  reason: z.string(),
  message: z.string().optional(),
  toolCallId: z.string().optional(),
  responseSchema: z.record(z.any()).optional(),
  expiresAt: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  // The subagent whose work raised this interrupt, when it was raised inside
  // one — absent for a root-raised interrupt. Attribution lives on each
  // interrupt rather than on RUN_FINISHED because one run can carry
  // interrupts from several subagents. Lets a client render the approval
  // request inside that subagent's group without correlating the legacy
  // on_interrupt CUSTOM event by ordering.
  subagentRunId: z.string().optional(),
});

export const ResumeEntrySchema = z.object({
  interruptId: z.string(),
  status: z.enum(["resolved", "cancelled"]),
  payload: z.any().optional(),
  // Envelope data about the response — signatures, routing keys — as opposed to
  // `payload`, which is the answer the agent asked for and will act on.
  metadata: OptionalMetadataSchema,
});

export const RunAgentInputSchema = z.object({
  threadId: z.string(),
  runId: z.string(),
  parentRunId: z.string().optional(),
  // Optional by contract: absent means "no state", and a bare null reads as
  // absent — every consumer collapses the two, and .NET's representation cannot
  // tell them apart, so omission is the one spelling all SDKs share. This is
  // the coerce pattern (not metadata's reject) because hand-rolled clients
  // sending "state": null plausibly exist. Nulls INSIDE state are values.
  state: z.any().transform((v) => v ?? undefined),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema),
  context: z.array(ContextSchema),
  forwardedProps: z.any(),
  resume: z.array(ResumeEntrySchema).optional(),
});

export const StateSchema = z.any();

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type FunctionCall = z.infer<typeof FunctionCallSchema>;
export type TextInputContent = z.infer<typeof TextInputContentSchema>;
export type InputContentDataSource = z.infer<typeof InputContentDataSourceSchema>;
export type InputContentUrlSource = z.infer<typeof InputContentUrlSourceSchema>;
export type InputContentSource = z.infer<typeof InputContentSourceSchema>;
export type ImageInputContent = z.infer<typeof ImageInputContentSchema>;
export type AudioInputContent = z.infer<typeof AudioInputContentSchema>;
export type VideoInputContent = z.infer<typeof VideoInputContentSchema>;
export type DocumentInputContent = z.infer<typeof DocumentInputContentSchema>;
export type ImageInputPart = ImageInputContent;
export type AudioInputPart = AudioInputContent;
export type VideoInputPart = VideoInputContent;
export type DocumentInputPart = DocumentInputContent;
export type BinaryInputContent = z.infer<typeof BinaryInputContentSchema>;
export type InputContent = z.infer<typeof InputContentSchema>;
export type InputContentPart = z.infer<typeof InputContentSchema>;
export type DeveloperMessage = z.infer<typeof DeveloperMessageSchema>;
export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type ToolMessage = z.infer<typeof ToolMessageSchema>;
export type ActivityMessage = z.infer<typeof ActivityMessageSchema>;
export type ReasoningMessage = z.infer<typeof ReasoningMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type RunAgentInput = z.infer<typeof RunAgentInputSchema>;
export type State = z.infer<typeof StateSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Interrupt = z.infer<typeof InterruptSchema>;
export type ResumeEntry = z.infer<typeof ResumeEntrySchema>;
export type ResumeStatus = z.infer<typeof ResumeEntrySchema>["status"];

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AGUIConnectNotImplementedError extends AGUIError {
  constructor() {
    super("Connect not implemented. This method is not supported by the current agent.");
  }
}
