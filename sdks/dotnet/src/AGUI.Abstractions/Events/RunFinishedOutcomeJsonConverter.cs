using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class RunFinishedOutcomeJsonConverter : JsonConverter<RunFinishedOutcome>
{
    private const string TypeDiscriminatorPropertyName = "type";

    public override bool CanConvert(Type typeToConvert) =>
        typeof(RunFinishedOutcome).IsAssignableFrom(typeToConvert);

    public override RunFinishedOutcome Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;

        if (!jsonElement.TryGetProperty(TypeDiscriminatorPropertyName, out JsonElement discriminatorElement))
        {
            throw new JsonException($"Missing required property '{TypeDiscriminatorPropertyName}' for RunFinishedOutcome deserialization");
        }

        string? discriminator = discriminatorElement.GetString();

        RunFinishedOutcome? result = discriminator switch
        {
            RunFinishedOutcomeTypes.Success => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(RunFinishedSuccessOutcome))) as RunFinishedSuccessOutcome,
            RunFinishedOutcomeTypes.Interrupt => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(RunFinishedInterruptOutcome))) as RunFinishedInterruptOutcome,
            _ => throw new JsonException($"Unknown RunFinishedOutcome type discriminator: '{discriminator}'")
        };

        return result ?? throw new JsonException($"Failed to deserialize RunFinishedOutcome with type: '{discriminator}'");
    }

    public override void Write(
        Utf8JsonWriter writer,
        RunFinishedOutcome value,
        JsonSerializerOptions options)
    {
        switch (value)
        {
            case RunFinishedSuccessOutcome success:
                JsonSerializer.Serialize(writer, success, options.GetTypeInfo(typeof(RunFinishedSuccessOutcome)));
                break;
            case RunFinishedInterruptOutcome interrupt:
                JsonSerializer.Serialize(writer, interrupt, options.GetTypeInfo(typeof(RunFinishedInterruptOutcome)));
                break;
            default:
                throw new JsonException($"Unknown RunFinishedOutcome type: {value.GetType().Name}");
        }
    }
}
