using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class AGUIInputContentSourceJsonConverter : JsonConverter<AGUIInputContentSource>
{
    private const string TypeDiscriminatorPropertyName = "type";

    public override bool CanConvert(Type typeToConvert) =>
        typeof(AGUIInputContentSource).IsAssignableFrom(typeToConvert);

    public override AGUIInputContentSource Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;

        if (!jsonElement.TryGetProperty(TypeDiscriminatorPropertyName, out JsonElement discriminatorElement))
        {
            throw new JsonException(
                $"Missing required property '{TypeDiscriminatorPropertyName}' for AGUIInputContentSource deserialization");
        }

        string? discriminator = discriminatorElement.GetString();

        AGUIInputContentSource? result = discriminator switch
        {
            AGUIInputContentSourceTypes.Data => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIInputContentDataSource))) as AGUIInputContentDataSource,
            AGUIInputContentSourceTypes.Url => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIInputContentUrlSource))) as AGUIInputContentUrlSource,
            _ => throw new JsonException($"Unknown AGUIInputContentSource type discriminator: '{discriminator}'")
        };

        return result ?? throw new JsonException(
            $"Failed to deserialize AGUIInputContentSource with type: '{discriminator}'");
    }

    public override void Write(
        Utf8JsonWriter writer,
        AGUIInputContentSource value,
        JsonSerializerOptions options)
    {
        switch (value)
        {
            case AGUIInputContentDataSource data:
                JsonSerializer.Serialize(writer, data, options.GetTypeInfo(typeof(AGUIInputContentDataSource)));
                break;
            case AGUIInputContentUrlSource url:
                JsonSerializer.Serialize(writer, url, options.GetTypeInfo(typeof(AGUIInputContentUrlSource)));
                break;
            default:
                throw new JsonException($"Unknown AGUIInputContentSource type: {value.GetType().Name}");
        }
    }
}
