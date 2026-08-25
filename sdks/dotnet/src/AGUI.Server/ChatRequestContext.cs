using System.Collections.Generic;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server;

/// <summary>
/// The Microsoft.Extensions.AI-shaped request derived from an AG-UI
/// <see cref="RunAgentInput"/>.
/// </summary>
/// <remarks>
/// <para>
/// Produced by <see cref="RunAgentInputExtensions.ToChatRequestContext"/> and consumed by
/// <see cref="ChatResponseUpdateAGUIExtensions.AsAGUIEventStreamAsync(System.Collections.Generic.IAsyncEnumerable{Microsoft.Extensions.AI.ChatResponseUpdate}, ChatRequestContext, System.Threading.CancellationToken)"/>.
/// Carries everything the AG-UI ↔ Microsoft.Extensions.AI round-trip needs: the original input, the
/// adapted message list, fully configured <see cref="ChatOptions"/> (with client tools already
/// routed through the approval-flow pipeline), and the stream-converter configuration.
/// </para>
/// <para>
/// Callers do not construct this directly — the only public path is
/// <see cref="RunAgentInputExtensions.ToChatRequestContext"/>.
/// </para>
/// </remarks>
public sealed class ChatRequestContext
{
    internal ChatRequestContext(
        RunAgentInput input,
        List<ChatMessage> messages,
        ChatOptions chatOptions,
        AGUIStreamOptions streamOptions,
        JsonSerializerOptions jsonSerializerOptions,
        bool isContinuation,
        IReadOnlySet<string> clientToolNames)
    {
        Input = input;
        Messages = messages;
        ChatOptions = chatOptions;
        StreamOptions = streamOptions;
        JsonSerializerOptions = jsonSerializerOptions;
        IsContinuation = isContinuation;
        ClientToolNames = clientToolNames;
    }

    /// <summary>
    /// Gets the originating AG-UI input. Also recoverable from the request's
    /// <see cref="ChatOptions"/> via <see cref="RunAgentInputExtensions.TryGetRunAgentInput"/> for
    /// delegating chat clients and server tools that only see the <see cref="ChatOptions"/>.
    /// </summary>
    public RunAgentInput Input { get; }

    /// <summary>
    /// Gets the chat messages adapted from <see cref="RunAgentInput.Messages"/>.
    /// </summary>
    public List<ChatMessage> Messages { get; }

    /// <summary>
    /// Gets the chat options. Client tools (if any) are already installed on
    /// <see cref="Microsoft.Extensions.AI.ChatOptions.Tools"/> via the approval-flow pipeline.
    /// </summary>
    public ChatOptions ChatOptions { get; }

    internal AGUIStreamOptions StreamOptions { get; }

    internal JsonSerializerOptions JsonSerializerOptions { get; }

    internal bool IsContinuation { get; }

    internal IReadOnlySet<string> ClientToolNames { get; }
}
