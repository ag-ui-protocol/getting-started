using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class AGUIInputContentJsonConverter : JsonConverter<AGUIInputContent>
{
    private const string TypeDiscriminatorPropertyName = "type";

    public override bool CanConvert(Type typeToConvert) =>
        typeof(AGUIInputContent).IsAssignableFrom(typeToConvert);

    public override AGUIInputContent Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;

        if (!jsonElement.TryGetProperty(TypeDiscriminatorPropertyName, out JsonElement discriminatorElement))
        {
            throw new JsonException(
                $"Missing required property '{TypeDiscriminatorPropertyName}' for AGUIInputContent deserialization");
        }

        string? discriminator = discriminatorElement.GetString();

        AGUIInputContent? result = discriminator switch
        {
            AGUIInputContentTypes.Text => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUITextInputContent))) as AGUITextInputContent,
            AGUIInputContentTypes.Image => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIImageInputContent))) as AGUIImageInputContent,
            AGUIInputContentTypes.Audio => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIAudioInputContent))) as AGUIAudioInputContent,
            AGUIInputContentTypes.Video => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIVideoInputContent))) as AGUIVideoInputContent,
            AGUIInputContentTypes.Document => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIDocumentInputContent))) as AGUIDocumentInputContent,
            AGUIInputContentTypes.Binary => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIBinaryInputContent))) as AGUIBinaryInputContent,
            _ => throw new JsonException($"Unknown AGUIInputContent type discriminator: '{discriminator}'")
        };

        return result ?? throw new JsonException(
            $"Failed to deserialize AGUIInputContent with type: '{discriminator}'");
    }

    public override void Write(
        Utf8JsonWriter writer,
        AGUIInputContent value,
        JsonSerializerOptions options)
    {
        switch (value)
        {
            case AGUITextInputContent text:
                JsonSerializer.Serialize(writer, text, options.GetTypeInfo(typeof(AGUITextInputContent)));
                break;
            case AGUIImageInputContent image:
                JsonSerializer.Serialize(writer, image, options.GetTypeInfo(typeof(AGUIImageInputContent)));
                break;
            case AGUIAudioInputContent audio:
                JsonSerializer.Serialize(writer, audio, options.GetTypeInfo(typeof(AGUIAudioInputContent)));
                break;
            case AGUIVideoInputContent video:
                JsonSerializer.Serialize(writer, video, options.GetTypeInfo(typeof(AGUIVideoInputContent)));
                break;
            case AGUIDocumentInputContent document:
                JsonSerializer.Serialize(writer, document, options.GetTypeInfo(typeof(AGUIDocumentInputContent)));
                break;
            case AGUIBinaryInputContent binary:
                JsonSerializer.Serialize(writer, binary, options.GetTypeInfo(typeof(AGUIBinaryInputContent)));
                break;
            default:
                throw new JsonException($"Unknown AGUIInputContent type: {value.GetType().Name}");
        }
    }
}
