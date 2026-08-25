using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class AGUIMessageJsonConverter : JsonConverter<AGUIMessage>
{
    private const string RoleDiscriminatorPropertyName = "role";

    public override bool CanConvert(Type typeToConvert) =>
        typeof(AGUIMessage).IsAssignableFrom(typeToConvert);

    public override AGUIMessage Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var jsonElementTypeInfo = options.GetTypeInfo(typeof(JsonElement));
        JsonElement jsonElement = (JsonElement)JsonSerializer.Deserialize(ref reader, jsonElementTypeInfo)!;

        if (!jsonElement.TryGetProperty(RoleDiscriminatorPropertyName, out JsonElement discriminatorElement))
        {
            throw new JsonException(
                $"Missing required property '{RoleDiscriminatorPropertyName}' for AGUIMessage deserialization");
        }

        string? discriminator = discriminatorElement.GetString();

        AGUIMessage? result = discriminator switch
        {
            AGUIRoles.User => DeserializeUserMessage(jsonElement, options),
            AGUIRoles.Assistant => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIAssistantMessage))) as AGUIAssistantMessage,
            AGUIRoles.System => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUISystemMessage))) as AGUISystemMessage,
            AGUIRoles.Developer => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIDeveloperMessage))) as AGUIDeveloperMessage,
            AGUIRoles.Tool => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIToolMessage))) as AGUIToolMessage,
            AGUIRoles.Activity => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIActivityMessage))) as AGUIActivityMessage,
            AGUIRoles.Reasoning => jsonElement.Deserialize(
                options.GetTypeInfo(typeof(AGUIReasoningMessage))) as AGUIReasoningMessage,
            _ => throw new JsonException($"Unknown AGUIMessage role discriminator: '{discriminator}'")
        };

        if (result == null)
        {
            throw new JsonException(
                $"Failed to deserialize AGUIMessage with role discriminator: '{discriminator}'");
        }

        return result;
    }

    private static AGUIUserMessage DeserializeUserMessage(JsonElement jsonElement, JsonSerializerOptions options)
    {
        var userMessage = new AGUIUserMessage
        {
            // Required on every role, so the model's property is non-nullable: an
            // empty id is schema-valid and stays empty, an absent one reads the same.
            Id = jsonElement.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? string.Empty : string.Empty,
            Name = jsonElement.TryGetProperty("name", out var nameProp) ? nameProp.GetString() : null,
            EncryptedValue = jsonElement.TryGetProperty("encryptedValue", out var encProp) ? encProp.GetString() : null,
            SubagentRunId = jsonElement.TryGetProperty("subagentRunId", out var subagentProp) ? subagentProp.GetString() : null,
            // An explicit null is read as absent, matching the TypeScript and
            // Python schemas — producers that serialize unset optionals as null
            // must still round-trip.
            Metadata = jsonElement.TryGetProperty("metadata", out var metadataProp)
                && metadataProp.ValueKind != JsonValueKind.Null
                    ? metadataProp.Clone()
                    : null,
        };

        if (jsonElement.TryGetProperty("content", out var contentProp))
        {
            if (contentProp.ValueKind == JsonValueKind.String)
            {
                userMessage.Content = contentProp.GetString() ?? string.Empty;
            }
            else if (contentProp.ValueKind == JsonValueKind.Array)
            {
                var contents = new List<AGUIInputContent>();
                foreach (var element in contentProp.EnumerateArray())
                {
                    if (!element.TryGetProperty("type", out var typeProp))
                    {
                        throw new JsonException("Missing 'type' discriminator in InputContent");
                    }

                    var contentType = typeProp.GetString();
                    AGUIInputContent? inputContent = contentType switch
                    {
                        AGUIInputContentTypes.Text => element.Deserialize(
                            options.GetTypeInfo(typeof(AGUITextInputContent))) as AGUITextInputContent,
                        AGUIInputContentTypes.Image => element.Deserialize(
                            options.GetTypeInfo(typeof(AGUIImageInputContent))) as AGUIImageInputContent,
                        AGUIInputContentTypes.Audio => element.Deserialize(
                            options.GetTypeInfo(typeof(AGUIAudioInputContent))) as AGUIAudioInputContent,
                        AGUIInputContentTypes.Video => element.Deserialize(
                            options.GetTypeInfo(typeof(AGUIVideoInputContent))) as AGUIVideoInputContent,
                        AGUIInputContentTypes.Document => element.Deserialize(
                            options.GetTypeInfo(typeof(AGUIDocumentInputContent))) as AGUIDocumentInputContent,
                        _ => throw new JsonException($"Unknown InputContent type: '{contentType}'")
                    };

                    if (inputContent is not null)
                    {
                        contents.Add(inputContent);
                    }
                }

                userMessage.Content = contents;
            }
        }

        return userMessage;
    }

    public override void Write(
        Utf8JsonWriter writer,
        AGUIMessage value,
        JsonSerializerOptions options)
    {
        switch (value)
        {
            case AGUIUserMessage user:
                WriteUserMessage(writer, user, options);
                break;
            case AGUIAssistantMessage assistant:
                JsonSerializer.Serialize(writer, assistant, options.GetTypeInfo(typeof(AGUIAssistantMessage)));
                break;
            case AGUISystemMessage system:
                JsonSerializer.Serialize(writer, system, options.GetTypeInfo(typeof(AGUISystemMessage)));
                break;
            case AGUIDeveloperMessage developer:
                JsonSerializer.Serialize(writer, developer, options.GetTypeInfo(typeof(AGUIDeveloperMessage)));
                break;
            case AGUIToolMessage tool:
                JsonSerializer.Serialize(writer, tool, options.GetTypeInfo(typeof(AGUIToolMessage)));
                break;
            case AGUIActivityMessage activity:
                JsonSerializer.Serialize(writer, activity, options.GetTypeInfo(typeof(AGUIActivityMessage)));
                break;
            case AGUIReasoningMessage reasoning:
                JsonSerializer.Serialize(writer, reasoning, options.GetTypeInfo(typeof(AGUIReasoningMessage)));
                break;
            default:
                throw new JsonException($"Unknown AGUIMessage type: {value.GetType().Name}");
        }
    }

    private static void WriteUserMessage(Utf8JsonWriter writer, AGUIUserMessage user, JsonSerializerOptions options)
    {
        writer.WriteStartObject();

        if (user.Id is not null)
        {
            writer.WriteString("id", user.Id);
        }

        writer.WriteString("role", user.Role);

        if (user.Name is not null)
        {
            writer.WriteString("name", user.Name);
        }

        if (user.EncryptedValue is not null)
        {
            writer.WriteString("encryptedValue", user.EncryptedValue);
        }

        // Written explicitly because this role is hand-serialized for its polymorphic
        // content, so it does not inherit the base's properties the way the
        // source-generated roles do.
        if (user.SubagentRunId is not null)
        {
            writer.WriteString("subagentRunId", user.SubagentRunId);
        }

        if (user.Metadata is { } metadata)
        {
            writer.WritePropertyName("metadata");
            metadata.WriteTo(writer);
        }

        switch (user.Content.Value)
        {
            case string text:
                writer.WriteString("content", text);
                break;
            case IList<AGUIInputContent> parts when parts.Count == 1 && parts[0] is AGUITextInputContent singleTextContent:
                writer.WriteString("content", singleTextContent.Text);
                break;
            case IList<AGUIInputContent> parts when parts.Count > 0:
                writer.WritePropertyName("content");
                writer.WriteStartArray();
                foreach (var content in parts)
                {
                    JsonSerializer.Serialize(writer, content, options.GetTypeInfo(typeof(AGUIInputContent)));
                }
                writer.WriteEndArray();
                break;
            default:
                writer.WriteString("content", string.Empty);
                break;
        }

        writer.WriteEndObject();
    }
}
