using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Input payload for running an AG-UI agent.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class RunAgentInput
{
    /// <summary>
    /// Gets or sets the thread identifier.
    /// </summary>
    [JsonPropertyName("threadId")]
    public string ThreadId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the run identifier.
    /// </summary>
    [JsonPropertyName("runId")]
    public string RunId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the parent run identifier for branching/time travel.
    /// </summary>
    [JsonPropertyName("parentRunId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public string? ParentRunId { get; set; }

    /// <summary>
    /// Gets or sets the conversation messages.
    /// </summary>
    [JsonPropertyName("messages")]
    public IList<AGUIMessage> Messages { get; set; } = [];

    /// <summary>
    /// Gets or sets the tools available to the agent.
    /// </summary>
    [JsonPropertyName("tools")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public IList<AGUITool>? Tools { get; set; }

    /// <summary>
    /// Gets or sets the state to pass to the agent.
    /// </summary>
    [JsonPropertyName("state")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public JsonElement? State { get; set; }

    /// <summary>
    /// Gets or sets the resume entries for continuing an interrupted run.
    /// Each entry addresses one interrupt from the previous run.
    /// </summary>
    [JsonPropertyName("resume")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public IList<AGUIResume>? Resume { get; set; }

    /// <summary>
    /// Gets or sets contextual information for the agent.
    /// </summary>
    [JsonPropertyName("context")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public IList<AGUIContext>? Context { get; set; }

    /// <summary>
    /// Gets or sets additional forwarded properties from the client.
    /// </summary>
    [JsonPropertyName("forwardedProps")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public JsonElement ForwardedProperties { get; set; }
}
