using System.Text.Json.Serialization;

namespace AGUIDojoServer.AgenticUI;

internal sealed class Step
{
    [JsonPropertyName("description")]
    public required string Description { get; set; }

    [JsonPropertyName("status")]
    public StepStatus Status { get; set; } = StepStatus.Pending;
}
