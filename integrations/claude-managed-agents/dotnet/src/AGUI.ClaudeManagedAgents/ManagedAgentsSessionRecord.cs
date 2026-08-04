namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Persistent mapping between an AG-UI thread and a managed session.
/// </summary>
public sealed class ManagedAgentsSessionRecord
{
    /// <summary>
    /// Gets or sets the managed session identifier.
    /// </summary>
    public string SessionId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the custom tool names currently registered on the session's agent.
    /// </summary>
    public IList<string> ToolNames { get; set; } = [];

    /// <summary>
    /// Gets or sets the fingerprint of the canonical custom tool definitions registered on
    /// the session's agent.
    /// </summary>
    public string? ToolDefinitionsFingerprint { get; set; }

    /// <summary>
    /// Gets or sets the ID of the last user message forwarded into the session.
    /// </summary>
    public string? LastUserMessageId { get; set; }

    /// <summary>
    /// Gets or sets the custom tool calls handed to the frontend that the session is parked on.
    /// The next run must answer them with <c>role: "tool"</c> messages.
    /// </summary>
    public IList<string> PendingClientToolUseIds { get; set; } = [];
}
