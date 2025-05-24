using System.Collections.Immutable;
using System.Text.Json.Serialization;

namespace AGUIDotnet.Events;

public sealed record StateDeltaEvent : BaseEvent
{
    /// <summary>
    /// A collection of JSON-patch operations that describe the changes to the state.
    /// </summary>
    [JsonPropertyName("delta")]
    public required ImmutableList<object> Delta { get; init; } = [];
}