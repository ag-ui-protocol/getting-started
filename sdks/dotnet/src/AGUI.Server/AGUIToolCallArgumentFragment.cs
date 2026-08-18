namespace AGUI.Server;

/// <summary>
/// A single provider-native fragment of a streamed tool call's arguments, extracted from a
/// <see cref="Microsoft.Extensions.AI.ChatResponseUpdate"/> so the conversion can emit
/// incremental <see cref="AGUI.Abstractions.ToolCallArgsEvent"/>s (progressive tool-call
/// argument streaming) instead of one atomic event per call.
/// </summary>
/// <remarks>
/// Microsoft.Extensions.AI coalesces tool-call arguments and only attaches the typed
/// <see cref="Microsoft.Extensions.AI.FunctionCallContent"/> once a call is complete, so the
/// per-chunk deltas survive only on the provider's raw update. Because reading them is
/// provider-specific, the conversion does not depend on any provider SDK: callers register an
/// extractor via <see cref="AGUIStreamOptions.MapStreamingToolCallArguments"/>. The first
/// fragment of a call carries <see cref="ToolCallId"/> and <see cref="FunctionName"/>; later
/// fragments carry only <see cref="Index"/> and an <see cref="ArgumentsDelta"/>.
/// </remarks>
public sealed class AGUIToolCallArgumentFragment
{
    /// <summary>Gets the provider's per-turn tool-call index (restarts at 0 each assistant turn).</summary>
    public int Index { get; init; }

    /// <summary>Gets the call id, present only on the first fragment of a call.</summary>
    public string? ToolCallId { get; init; }

    /// <summary>Gets the function name, present only on the first fragment of a call.</summary>
    public string? FunctionName { get; init; }

    /// <summary>Gets the arguments fragment for this chunk (may be empty).</summary>
    public string ArgumentsDelta { get; init; } = string.Empty;
}
