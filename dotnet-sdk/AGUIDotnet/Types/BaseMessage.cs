using System.Text.Json.Serialization;

namespace AGUIDotnet.Types;

/// <summary>
/// Base class for all message types.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "role")]
[JsonDerivedType(typeof(DeveloperMessage), MessageRoles.Developer)]
[JsonDerivedType(typeof(SystemMessage), MessageRoles.System)]
[JsonDerivedType(typeof(AssistantMessage), MessageRoles.Assistant)]
[JsonDerivedType(typeof(UserMessage), MessageRoles.User)]
[JsonDerivedType(typeof(ToolMessage), MessageRoles.Tool)]
public abstract record BaseMessage
{
    [JsonPropertyName("id")]
    [JsonPropertyOrder(-1)]
    public required string Id { get; init; }
}
