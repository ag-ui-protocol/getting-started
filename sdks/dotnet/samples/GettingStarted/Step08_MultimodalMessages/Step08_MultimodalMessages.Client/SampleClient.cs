using System.Text.Json;
using AGUI.Client;
using Microsoft.Extensions.AI;

namespace Step08_MultimodalMessages.Client;

public static class SampleClient
{
    // 1×1 transparent PNG used for the standalone console run.
    private static readonly byte[] PlaceholderPng = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");

    public static async Task RunAsync(
        IChatClient chatClient,
        TextWriter output,
        byte[]? imageBytes = null,
        List<List<ChatMessage>>? messagesPerTurn = null,
        List<List<ChatResponseUpdate>>? updatesPerTurn = null,
        CancellationToken cancellationToken = default)
    {
        var bytes = imageBytes ?? PlaceholderPng;
        var image = new DataContent(bytes, "image/png")
        {
            Name = "ag-ui-logo.png",
            AdditionalProperties = new AdditionalPropertiesDictionary
            {
                ["metadata"] = JsonSerializer.SerializeToElement(new
                {
                    filename = "ag-ui-logo.png",
                    detail = "high",
                    providerHint = new { quality = "original" }
                })
            }
        };
        var messages = new List<ChatMessage>
        {
            new(ChatRole.User,
            [
                new TextContent("Describe this image"),
                image,
            ]),
        };
        messagesPerTurn?.Add(messages.ToList());
        await output.WriteLineAsync($"> Describe this image  ({bytes.Length} bytes)").ConfigureAwait(false);

        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in chatClient.GetStreamingResponseAsync(
            messages, options: null, cancellationToken).ConfigureAwait(false))
        {
            updates.Add(update);
            if (!string.IsNullOrEmpty(update.Text))
            {
                await output.WriteAsync(update.Text).ConfigureAwait(false);
            }
        }
        await output.WriteLineAsync().ConfigureAwait(false);
        updatesPerTurn?.Add(updates);
    }
}
