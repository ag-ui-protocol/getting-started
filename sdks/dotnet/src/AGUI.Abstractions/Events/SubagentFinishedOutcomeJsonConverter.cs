using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with RunFinishedOutcomeJsonConverter — same discriminated-union
// shape, one level down.
public sealed class SubagentFinishedOutcomeJsonConverter : JsonConverter<SubagentFinishedOutcome>
{
    private const string TypeDiscriminatorPropertyName = "type";

    public override bool CanConvert(Type typeToConvert) =>
        typeof(SubagentFinishedOutcome).IsAssignableFrom(typeToConvert);

    public override SubagentFinishedOutcome Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;

        if (!jsonElement.TryGetProperty(TypeDiscriminatorPropertyName, out JsonElement discriminatorElement))
        {
            throw new JsonException($"Missing required property '{TypeDiscriminatorPropertyName}' for SubagentFinishedOutcome deserialization");
        }

        string? discriminator = discriminatorElement.GetString();

        SubagentFinishedOutcome? result = discriminator switch
        {
            SubagentFinishedOutcomeTypes.Success => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(SubagentFinishedSuccessOutcome))) as SubagentFinishedSuccessOutcome,
            SubagentFinishedOutcomeTypes.Suspended => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(SubagentFinishedSuspendedOutcome))) as SubagentFinishedSuspendedOutcome,
            _ => throw new JsonException($"Unknown SubagentFinishedOutcome type discriminator: '{discriminator}'")
        };

        return result ?? throw new JsonException($"Failed to deserialize SubagentFinishedOutcome with type: '{discriminator}'");
    }

    public override void Write(
        Utf8JsonWriter writer,
        SubagentFinishedOutcome value,
        JsonSerializerOptions options)
    {
        switch (value)
        {
            case SubagentFinishedSuccessOutcome success:
                JsonSerializer.Serialize(writer, success, options.GetTypeInfo(typeof(SubagentFinishedSuccessOutcome)));
                break;
            case SubagentFinishedSuspendedOutcome suspended:
                JsonSerializer.Serialize(writer, suspended, options.GetTypeInfo(typeof(SubagentFinishedSuspendedOutcome)));
                break;
            default:
                throw new JsonException($"Unknown SubagentFinishedOutcome type: {value.GetType().Name}");
        }
    }
}
