using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class MessagesSnapshotEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.MessagesSnapshot;

    [JsonPropertyName("messages")]
    public IList<AGUIMessage> Messages { get; set; } = [];
}
