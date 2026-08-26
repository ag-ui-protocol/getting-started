using System.Text.Json;
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
    public string? Id { get; set; }

    [JsonPropertyName("role")]
    public abstract string Role { get; }

    /// <summary>
    /// Gets or sets the subagent that produced this message, absent for the parent
    /// agent's own. Declared on the base because the spec carries it on every role: a
    /// single MESSAGES_SNAPSHOT mixes the parent's messages with those of every subagent
    /// that ran, so attribution has to travel per message rather than per event.
    /// </summary>
    [JsonPropertyName("subagentRunId")]
    public string? SubagentRunId { get; set; }

    /// <summary>
    /// Extra information attached to this message, open by key.
    /// </summary>
    /// <remarks>
    /// Shared by every role, so it lives on the base. Any JSON value is allowed
    /// under a key, including <c>null</c>. The object itself is absent or an
    /// object, never <c>null</c>.
    ///
    /// The <c>ag-ui</c> key is reserved for AG-UI's own use; see <see
    /// cref="AGUIMetadata.ReservedKey"/>.
    ///
    /// This is a wire-level field by design, and is deliberately not surfaced on
    /// <c>Microsoft.Extensions.AI</c>'s <c>ChatMessage</c>. Review has asked for
    /// that more than once; it is declined for consistency, because no
    /// message-level AG-UI field is surfaced there today —
    /// <c>AGUIMessage.EncryptedValue</c>, <c>AGUIToolCall.EncryptedValue</c> and
    /// <c>AGUIToolMessage.Error</c> are all dropped by
    /// <c>AGUIChatMessageExtensions</c> in the same way. Surfacing metadata
    /// alone would make it the exception. Giving the .NET client a message
    /// reducer of its own is separate work.
    /// </remarks>
    [JsonPropertyName("metadata")]
    public JsonElement? Metadata { get; set; }
}
