using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server.IntegrationTests;

internal sealed class ServerCallCapture
{
    internal ServerCallCapture(RunAgentInput? runAgentInput, List<ChatMessage> messages, ChatOptions? options, List<ChatResponseUpdate> updates)
    {
        RunAgentInput = runAgentInput;
        Messages = messages;
        Options = options;
        Updates = updates;
    }

    internal RunAgentInput? RunAgentInput { get; }

    internal List<ChatMessage> Messages { get; }

    internal ChatOptions? Options { get; }

    internal List<ChatResponseUpdate> Updates { get; }
}
