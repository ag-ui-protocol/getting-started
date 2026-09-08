using System.Text.Json.Serialization;

namespace AGUIDojoServer.AgenticUI;

internal sealed class Plan
{
    [JsonPropertyName("steps")]
    public List<Step> Steps { get; set; } = [];
}
