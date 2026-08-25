using AGUI.Server;
using Microsoft.Extensions.AI;
using OpenAI.Chat;

namespace AGUIDojoServer.A2UI;

// Extracts OpenAI's per-chunk streamed tool-call argument fragments off a ChatResponseUpdate so
// A2UI surfaces paint progressively. Registered on the endpoint's AGUIStreamOptions via
// MapStreamingToolCallArguments (and on A2UIChatClientOptions.StreamingToolCallArgumentExtractor).
// This is the deliberate, isolated home for the OpenAI-SDK coupling: the provider-neutral
// AGUI.Server conversion never references any provider SDK, and a different provider would
// register its own extractor here instead.
internal static class OpenAIStreamingToolArguments
{
    public static IEnumerable<AGUIToolCallArgumentFragment>? Extract(ChatResponseUpdate update)
    {
        // Agent/middleware pipelines may wrap the provider update in one or more
        // ChatResponseUpdate layers; unwrap them all to reach the provider-native update.
        object? raw = update.RawRepresentation;
        while (raw is ChatResponseUpdate inner)
        {
            raw = inner.RawRepresentation;
        }

        return raw is StreamingChatCompletionUpdate streaming ? Fragments(streaming) : null;
    }

    private static IEnumerable<AGUIToolCallArgumentFragment> Fragments(StreamingChatCompletionUpdate streaming)
    {
        foreach (StreamingChatToolCallUpdate toolCall in streaming.ToolCallUpdates ?? [])
        {
            yield return new AGUIToolCallArgumentFragment
            {
                Index = toolCall.Index,
                ToolCallId = toolCall.ToolCallId,
                FunctionName = toolCall.FunctionName,
                ArgumentsDelta = toolCall.FunctionArgumentsUpdate?.ToString() ?? string.Empty,
            };
        }
    }
}
