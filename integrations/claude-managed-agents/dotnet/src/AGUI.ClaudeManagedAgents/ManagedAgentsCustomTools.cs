using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Builds managed-agent custom tool definitions from AG-UI (frontend) and backend tools.
/// </summary>
internal static partial class ManagedAgentsCustomTools
{
    /// <summary>
    /// Managed Agents tool names allow only <c>[A-Za-z0-9_-]</c>, at most 128 characters.
    /// </summary>
    internal static string NormalizeToolName(string name)
    {
        if (ValidNamePattern().IsMatch(name))
        {
            return name;
        }

        var normalized = ManagedAgentsText.Truncate(InvalidNameCharacterPattern().Replace(name, "_"), ManagedAgentsLimits.ToolNameMaxLength);
        return normalized.Length == 0 ? "tool" : normalized;
    }

    /// <summary>
    /// Converts a tool definition into a managed-agent <c>custom</c> tool JSON object.
    /// </summary>
    internal static JsonElement CustomToolFrom(string name, string? description, JsonElement parameters)
    {
        var displayDescription = string.IsNullOrEmpty(description) ? $"Tool {name}" : description;
        var tool = new JsonObject
        {
            ["type"] = "custom",
            ["name"] = NormalizeToolName(name),
            ["description"] = ManagedAgentsText.Truncate(displayDescription, ManagedAgentsLimits.ToolDescriptionMaxLength),
            ["input_schema"] = InputSchemaFrom(parameters),
        };
        return JsonSerializer.SerializeToElement(tool);
    }

    /// <summary>
    /// Reads the <c>name</c> of a tool definition JSON object, or <see langword="null"/> if it has none.
    /// </summary>
    internal static string? NameOf(JsonElement tool)
    {
        if (tool.ValueKind == JsonValueKind.Object
            && tool.TryGetProperty("name", out var name)
            && name.ValueKind == JsonValueKind.String)
        {
            return name.GetString();
        }

        return null;
    }

    /// <summary>
    /// Returns a canonical representation used to detect any change to a session's tool list.
    /// </summary>
    /// <remarks>
    /// Fingerprints whatever list is actually registered on the session — base tools included, not
    /// just the custom ones — because an override session's list is a full replacement frozen at
    /// the last update: a Console edit to the agent's own tools changes what the session should
    /// hold without changing any custom tool.
    /// </remarks>
    internal static string FingerprintOf(IEnumerable<JsonElement> tools)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var tool in tools)
            {
                WriteCanonical(tool, writer);
            }

            writer.WriteEndArray();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCanonical(JsonElement element, Utf8JsonWriter writer)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(
                    static property => property.Name,
                    StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(property.Value, writer);
                }

                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                {
                    WriteCanonical(item, writer);
                }

                writer.WriteEndArray();
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }

    /// <summary>
    /// The AG-UI tool's JSON Schema, as a managed-agent input schema.
    /// </summary>
    /// <remarks>
    /// The caller's schema is passed through whole: <c>$defs</c>, <c>$ref</c>, <c>oneOf</c>,
    /// <c>additionalProperties</c>, per-property descriptions and any other keyword survive.
    /// Copying only <c>properties</c> and <c>required</c> used to drop the rest — which silently
    /// invalidated every <c>$ref</c> whose <c>$defs</c> went with it — so anything the API accepts
    /// must reach it intact. <c>type</c> is the one field forced: the API accepts object input
    /// schemas only.
    /// </remarks>
    private static JsonObject InputSchemaFrom(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            return new JsonObject { ["type"] = "object", ["properties"] = new JsonObject() };
        }

        var schema = JsonNode.Parse(parameters.GetRawText())!.AsObject();
        schema["type"] = "object";
        return schema;
    }

    // \z, not $: in .NET `$` also matches immediately before a trailing newline, so
    // "show_chart\n" would pass validation and be forwarded to the API unchanged.
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,128}\z")]
    private static partial Regex ValidNamePattern();

    [GeneratedRegex("[^A-Za-z0-9_-]")]
    private static partial Regex InvalidNameCharacterPattern();
}
