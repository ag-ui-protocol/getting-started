using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

public sealed class RunFinishedInterruptOutcome : RunFinishedOutcome
{
    [JsonPropertyName("type")]
    public override string Type => RunFinishedOutcomeTypes.Interrupt;

    [JsonPropertyName("interrupts")]
    public IList<AGUIInterrupt> Interrupts { get; set; } = [];
}
