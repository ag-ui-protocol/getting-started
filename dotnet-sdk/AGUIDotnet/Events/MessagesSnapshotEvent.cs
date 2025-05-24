using System.Collections.Immutable;
using System.Text.Json.Serialization;
using AGUIDotnet.Types;

namespace AGUIDotnet.Events;

public sealed record MessagesSnapshotEvent : BaseEvent
{
    [JsonPropertyName("messages")]
    public required ImmutableList<BaseMessage> Messages { get; init; } = [];
}