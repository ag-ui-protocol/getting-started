using System.Text.Json.Serialization;

namespace AGUIDojoServer.PredictiveStateUpdates;

internal sealed class DocumentState
{
    [JsonPropertyName("document")]
    public string Document { get; set; } = string.Empty;
}
