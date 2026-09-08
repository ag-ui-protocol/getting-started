using System.Text.Json.Serialization;

namespace AGUIDojoServer.AgenticUI;

internal sealed class JsonPatchOperation
{
    [JsonPropertyName("op")]
    public required string Op { get; set; }

    [JsonPropertyName("path")]
    public required string Path { get; set; }

    [JsonPropertyName("value")]
    public object? Value { get; set; }

    [JsonPropertyName("from")]
    public string? From { get; set; }
}
