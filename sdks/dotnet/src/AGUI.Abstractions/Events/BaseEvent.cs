using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Base class for all AG-UI protocol events.
/// </summary>
[JsonConverter(typeof(BaseEventJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public abstract class BaseEvent
{
    /// <summary>
    /// Gets the event type discriminator.
    /// </summary>
    [JsonPropertyName("type")]
    public abstract string Type { get; }

    /// <summary>
    /// Gets or sets the optional timestamp.
    /// </summary>
    [JsonPropertyName("timestamp")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? Timestamp { get; set; }

    /// <summary>
    /// Gets or sets the optional raw event data.
    /// </summary>
    [JsonPropertyName("rawEvent")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? RawEvent { get; set; }

    /// <summary>
    /// Gets or sets extra information attached to this event, open by key.
    /// </summary>
    /// <remarks>
    /// Declared here rather than per event, so every event type carries it. Any
    /// JSON value is allowed under a key, including <c>null</c>. The object
    /// itself is absent or an object, never <c>null</c> — <see
    /// cref="JsonIgnoreCondition.WhenWritingNull"/> keeps an absent object off
    /// the wire rather than emitting a null in its place.
    ///
    /// The <c>ag-ui</c> key is reserved for AG-UI's own use; see <see
    /// cref="AGUIMetadata.ReservedKey"/>.
    /// </remarks>
    [JsonPropertyName("metadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Metadata { get; set; }
}
