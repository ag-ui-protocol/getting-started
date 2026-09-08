namespace AGUI.Server;

/// <summary>
/// Well-known string constants used by the AG-UI hosting layer.
/// </summary>
internal static class AGUIConstants
{
    /// <summary>
    /// The key used by <see cref="RunAgentInputExtensions.ToChatRequestContext"/> to stash the
    /// originating <see cref="AGUI.Abstractions.RunAgentInput"/> inside
    /// <see cref="Microsoft.Extensions.AI.ChatOptions.AdditionalProperties"/>. This is an internal
    /// implementation detail; delegating <see cref="Microsoft.Extensions.AI.IChatClient"/>
    /// implementations recover the input via
    /// <see cref="RunAgentInputExtensions.TryGetRunAgentInput"/>.
    /// </summary>
    internal const string RunAgentInputKey = "agui_input";
}
