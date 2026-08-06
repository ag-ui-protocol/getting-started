using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

[JsonConverter(typeof(AGUIMessageJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/types.ts
// The base carries only the fields shared by every message role (id, role). Each role
// declares its own content/name/encryptedValue exactly as the spec models them, so there
// is nothing to shadow.
public abstract class AGUIMessage
{
    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Id { get; set; }

    [JsonPropertyName("role")]
    public abstract string Role { get; }

    /// <summary>
    /// Gets or sets the subagent that produced this message, absent for the parent
    /// agent's own. Declared on the base because the spec carries it on every role: a
    /// single MESSAGES_SNAPSHOT mixes the parent's messages with those of every subagent
    /// that ran, so attribution has to travel per message rather than per event.
    /// </summary>
    [JsonPropertyName("subagentId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? SubagentId { get; set; }
}
