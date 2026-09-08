using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace Step06_RawEvents.Server;

/// <summary>
/// A stateless <see cref="DelegatingChatClient"/> that forwards the model's raw
/// <see cref="UsageDetails"/> to the client as AG-UI <see cref="RawEvent"/>s, demonstrating
/// how to carry provider-specific data the protocol does not model.
/// </summary>
/// <remarks>
/// <para>
/// Standard token counts do <b>not</b> need this: the hosting layer already accumulates
/// <see cref="UsageContent"/> and emits it as typed <see cref="TokenUsage"/> on
/// <see cref="RunFinishedEvent.Usage"/>, which every AG-UI SDK understands. Reach for a
/// <see cref="RawEvent"/> only for the long tail the typed field deliberately omits — here
/// <see cref="UsageDetails.AdditionalCounts"/>, which carries provider-specific entries such
/// as OpenAI's accepted/rejected prediction tokens.
/// </para>
/// <para>
/// So this sample emits both, and the contrast is the point: <c>RUN_FINISHED.usage</c> is
/// normalised, typed, and portable across SDKs, while the raw event is an opaque
/// passthrough of one provider's shape that only a client written against that provider
/// can interpret. Prefer the typed field wherever it covers your needs.
/// </para>
/// <para>
/// Mechanically, the payload is attached to a <see cref="ChatResponseUpdate"/> via
/// <see cref="ChatResponseUpdate.RawRepresentation"/>; the hosting layer's
/// <c>AsAGUIEventStreamAsync</c> recognises a <see cref="BaseEvent"/> raw representation and
/// emits it verbatim, so no other plumbing is required to inject protocol events.
/// </para>
/// </remarks>
internal sealed class UsageRawEventsChatClient : DelegatingChatClient
{
    private readonly JsonSerializerOptions _jsonSerializerOptions;

    public UsageRawEventsChatClient(IChatClient innerClient, JsonSerializerOptions jsonSerializerOptions)
        : base(innerClient)
    {
        _jsonSerializerOptions = jsonSerializerOptions;
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var update in base.GetStreamingResponseAsync(messages, options, cancellationToken).ConfigureAwait(false))
        {
            yield return update;

            foreach (var usage in update.Contents.OfType<UsageContent>())
            {
                yield return ToRawUsageEvent(usage.Details);
            }
        }
    }

    private ChatResponseUpdate ToRawUsageEvent(UsageDetails details) =>
        new()
        {
            RawRepresentation = new RawEvent
            {
                Source = "usage",
                Event = JsonSerializer.SerializeToElement(details, _jsonSerializerOptions),
            },
        };
}
