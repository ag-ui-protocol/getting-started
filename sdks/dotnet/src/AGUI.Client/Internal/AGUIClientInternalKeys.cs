namespace AGUI.Client;

// Internal keys used by AGUIChatClient and its helpers to thread information through
// Microsoft.Extensions.AI.AdditionalPropertiesDictionary instances across pipeline
// boundaries. These are not part of the public surface; callers should drive the wire
// format through ChatOptions.RawRepresentationFactory (returning a RunAgentInput) instead.
internal static class AGUIClientInternalKeys
{
    // Carries the AG-UI thread id when ChatOptions.ConversationId must be cleared so
    // FunctionInvokingChatClient sends the full message history on each turn.
    internal const string ThreadId = "agui_thread_id";

    // Carries a list of ToolApprovalResponseContent items from the outer chat client to
    // BuildRunAgentInput so they can be encoded as AGUIResume entries.
    internal const string ApprovalResponses = "agui_approval_responses";

    // Carries a list of InterruptResponseContent items from the outer chat client to
    // BuildRunAgentInput so they can be encoded as AGUIResume entries.
    internal const string InterruptResponses = "agui_interrupt_responses";
}
