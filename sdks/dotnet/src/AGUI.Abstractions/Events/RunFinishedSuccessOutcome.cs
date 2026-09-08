using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class RunFinishedSuccessOutcome : RunFinishedOutcome
{
    [JsonPropertyName("type")]
    public override string Type => RunFinishedOutcomeTypes.Success;
}
