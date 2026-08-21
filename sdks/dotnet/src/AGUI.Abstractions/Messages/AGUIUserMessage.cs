using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIUserMessage : AGUIMessage
{
    public override string Role => AGUIRoles.User;

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("encryptedValue")]
    public string? EncryptedValue { get; set; }

    // Wire format (string | InputContent[]) is owned by AGUIMessageJsonConverter.
    [JsonIgnore]
    public AGUIUserContent Content { get; set; }
}
