using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Source-generated JSON serializer context for AG-UI types.
/// Types are added incrementally as each slice is implemented.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="JsonIgnoreCondition.WhenWritingNull"/> is set here, once, as the context-wide
/// default: a property with no value is left out of the JSON rather than written as
/// <c>null</c>. That matches what TypeScript producers put on the wire and is the whole
/// reason this is a global setting instead of a per-property attribute — an attribute has
/// to be remembered on every new nullable property, and forgetting one emits a <c>null</c>
/// that receiving SDKs reject.
/// </para>
/// <para>
/// <strong>The setting belongs to this context's own <see cref="JsonSerializerContext.Options"/>
/// and does not travel.</strong> Serializing through <c>Default.&lt;Type&gt;</c> — what the SSE
/// formatter, the protobuf formatter and the HTTP transport all do — gets the omission.
/// Inserting <c>Default</c> into a *different* <see cref="JsonSerializerOptions"/> does not:
/// the source generator leaves the per-property ignore condition unset, so those options fall
/// back to their own <c>DefaultIgnoreCondition</c> and the nulls come back. Compose AG-UI types
/// into caller-owned options with <see cref="AGUIJsonUtilities.DefaultTypeInfoResolver"/>
/// instead, which carries the rule on the type metadata. <c>NullOmissionTest</c>'s
/// <c>RawContextInsertedIntoCallerOwnedOptionsIsNotEnough</c> pins this distinction.
/// </para>
/// <para>
/// Guarded by <c>NullOmissionTest</c> in <c>AGUI.Abstractions.UnitTests</c>, which walks
/// every wire type by reflection and fails on any <c>null</c> the contract does not permit.
/// Properties that need <see cref="JsonIgnoreCondition.WhenWritingDefault"/> instead (a
/// non-nullable <see cref="JsonElement"/>, say) still declare it explicitly.
/// </para>
/// </remarks>
[JsonSerializable(typeof(BaseEvent))]
[JsonSerializable(typeof(RunStartedEvent))]
[JsonSerializable(typeof(RunFinishedEvent))]
[JsonSerializable(typeof(RunErrorEvent))]
[JsonSerializable(typeof(StepStartedEvent))]
[JsonSerializable(typeof(StepFinishedEvent))]
[JsonSerializable(typeof(TokenUsage))]
[JsonSerializable(typeof(IList<TokenUsage>))]
[JsonSerializable(typeof(AGUIInterrupt))]
[JsonSerializable(typeof(IList<AGUIInterrupt>))]
[JsonSerializable(typeof(AGUIResume))]
[JsonSerializable(typeof(IList<AGUIResume>))]
[JsonSerializable(typeof(AGUIContext))]
[JsonSerializable(typeof(IList<AGUIContext>))]
[JsonSerializable(typeof(RunFinishedOutcome))]
[JsonSerializable(typeof(RunFinishedSuccessOutcome))]
[JsonSerializable(typeof(RunFinishedInterruptOutcome))]
[JsonSerializable(typeof(AGUIToolApprovalPayload))]
[JsonSerializable(typeof(AGUIToolApprovalResumePayload))]
[JsonSerializable(typeof(AGUIToolCallInfo))]
[JsonSerializable(typeof(RunAgentInput))]
[JsonSerializable(typeof(TextMessageStartEvent))]
[JsonSerializable(typeof(TextMessageContentEvent))]
[JsonSerializable(typeof(TextMessageEndEvent))]
[JsonSerializable(typeof(AGUIMessage))]
[JsonSerializable(typeof(AGUIUserMessage))]
[JsonSerializable(typeof(AGUIAssistantMessage))]
[JsonSerializable(typeof(AGUISystemMessage))]
[JsonSerializable(typeof(AGUIDeveloperMessage))]
[JsonSerializable(typeof(AGUIToolMessage))]
[JsonSerializable(typeof(AGUIActivityMessage))]
[JsonSerializable(typeof(AGUIReasoningMessage))]
[JsonSerializable(typeof(AGUIToolCall))]
[JsonSerializable(typeof(AGUIToolCallFunction))]
[JsonSerializable(typeof(AGUIInputContent))]
[JsonSerializable(typeof(AGUITextInputContent))]
[JsonSerializable(typeof(AGUIImageInputContent))]
[JsonSerializable(typeof(AGUIAudioInputContent))]
[JsonSerializable(typeof(AGUIVideoInputContent))]
[JsonSerializable(typeof(AGUIDocumentInputContent))]
[JsonSerializable(typeof(AGUIBinaryInputContent))]
[JsonSerializable(typeof(AGUIInputContentSource))]
[JsonSerializable(typeof(AGUIInputContentDataSource))]
[JsonSerializable(typeof(AGUIInputContentUrlSource))]
[JsonSerializable(typeof(ToolCallStartEvent))]
[JsonSerializable(typeof(ToolCallArgsEvent))]
[JsonSerializable(typeof(ToolCallEndEvent))]
[JsonSerializable(typeof(ToolCallResultEvent))]
[JsonSerializable(typeof(AGUITool))]
[JsonSerializable(typeof(StateSnapshotEvent))]
[JsonSerializable(typeof(StateDeltaEvent))]
[JsonSerializable(typeof(ReasoningStartEvent))]
[JsonSerializable(typeof(ReasoningMessageStartEvent))]
[JsonSerializable(typeof(ReasoningMessageContentEvent))]
[JsonSerializable(typeof(ReasoningMessageEndEvent))]
[JsonSerializable(typeof(ReasoningMessageChunkEvent))]
[JsonSerializable(typeof(ReasoningEndEvent))]
[JsonSerializable(typeof(ReasoningEncryptedValueEvent))]
[JsonSerializable(typeof(ActivitySnapshotEvent))]
[JsonSerializable(typeof(ActivityDeltaEvent))]
[JsonSerializable(typeof(CustomEvent))]
[JsonSerializable(typeof(RawEvent))]
[JsonSerializable(typeof(MessagesSnapshotEvent))]
[JsonSerializable(typeof(SubagentStartedEvent))]
[JsonSerializable(typeof(SubagentFinishedEvent))]
[JsonSerializable(typeof(SubagentFinishedOutcome))]
[JsonSerializable(typeof(SubagentFinishedSuccessOutcome))]
[JsonSerializable(typeof(SubagentFinishedSuspendedOutcome))]
[JsonSerializable(typeof(SubagentErrorEvent))]
[JsonSerializable(typeof(AgentCapabilities))]
[JsonSerializable(typeof(IdentityCapabilities))]
[JsonSerializable(typeof(TransportCapabilities))]
[JsonSerializable(typeof(ToolsCapabilities))]
[JsonSerializable(typeof(OutputCapabilities))]
[JsonSerializable(typeof(StateCapabilities))]
[JsonSerializable(typeof(MultiAgentCapabilities))]
[JsonSerializable(typeof(SubAgentInfo))]
[JsonSerializable(typeof(ReasoningCapabilities))]
[JsonSerializable(typeof(MultimodalCapabilities))]
[JsonSerializable(typeof(MultimodalInputCapabilities))]
[JsonSerializable(typeof(MultimodalOutputCapabilities))]
[JsonSerializable(typeof(ExecutionCapabilities))]
[JsonSerializable(typeof(HumanInTheLoopCapabilities))]
[JsonSerializable(typeof(IDictionary<string, object?>))]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(JsonElement?))]
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
public partial class AGUIJsonSerializerContext : JsonSerializerContext
{
}
