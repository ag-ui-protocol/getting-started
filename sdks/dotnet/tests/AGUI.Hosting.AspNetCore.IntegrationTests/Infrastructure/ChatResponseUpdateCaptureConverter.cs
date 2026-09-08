using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;

namespace AGUI.Server.IntegrationTests;

/// <summary>
/// Serializes <see cref="ChatResponseUpdate"/> like the default resolver but additionally
/// round-trips <see cref="ChatResponseUpdate.RawRepresentation"/> when it carries an AG-UI
/// <see cref="BaseEvent"/> (the mechanism wrappers use to inject protocol events into the
/// stream, e.g. state or raw/usage events). Opaque provider representations (such as the
/// OpenAI streaming chunks) are not round-trippable and are intentionally skipped, matching
/// the "capture everything that is serializable" rule for baselines and replay recordings.
/// </summary>
internal sealed class ChatResponseUpdateCaptureConverter : JsonConverter<ChatResponseUpdate>
{
    private const string RawRepresentationProperty = "rawRepresentation";

    private static readonly ConditionalWeakTable<JsonSerializerOptions, JsonSerializerOptions> s_inner = new();

    public override ChatResponseUpdate? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var inner = GetInnerOptions(options);

        if (JsonNode.Parse(ref reader) is not JsonObject obj)
        {
            return null;
        }

        JsonNode? rawNode = null;
        if (obj.TryGetPropertyValue(RawRepresentationProperty, out rawNode))
        {
            obj.Remove(RawRepresentationProperty);
        }

        var update = obj.Deserialize<ChatResponseUpdate>(inner);
        if (update is not null && rawNode is not null)
        {
            update.RawRepresentation = rawNode.Deserialize<BaseEvent>(inner);
        }

        return update;
    }

    public override void Write(Utf8JsonWriter writer, ChatResponseUpdate value, JsonSerializerOptions options)
    {
        var inner = GetInnerOptions(options);

        if (JsonSerializer.SerializeToNode(value, inner) is not JsonObject obj)
        {
            writer.WriteNullValue();
            return;
        }

        if (value.RawRepresentation is BaseEvent baseEvent)
        {
            obj[RawRepresentationProperty] = JsonSerializer.SerializeToNode(baseEvent, inner);
        }

        obj.WriteTo(writer);
    }

    private static JsonSerializerOptions GetInnerOptions(JsonSerializerOptions options) =>
        s_inner.GetValue(options, source =>
        {
            var copy = new JsonSerializerOptions(source);
            for (int i = copy.Converters.Count - 1; i >= 0; i--)
            {
                if (copy.Converters[i] is ChatResponseUpdateCaptureConverter)
                {
                    copy.Converters.RemoveAt(i);
                }
            }

            return copy;
        });
}
