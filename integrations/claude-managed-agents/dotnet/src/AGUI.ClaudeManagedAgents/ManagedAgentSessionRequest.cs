using System.Text.Json;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// The parameters used to create a managed session.
/// </summary>
public sealed class ManagedAgentSessionRequest
{
    /// <summary>
    /// Gets or sets the ID of the managed agent that powers the session.
    /// </summary>
    public string ManagedAgentId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the pinned agent version, or <see langword="null"/> for the latest.
    /// </summary>
    public int? AgentVersion { get; set; }

    /// <summary>
    /// Gets or sets the ID of the environment the agent runs in.
    /// </summary>
    public string EnvironmentId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the session title.
    /// </summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the vault IDs (<c>vlt_...</c>) for stored credentials the agent may use, or
    /// <see langword="null"/> for none.
    /// </summary>
    public IReadOnlyList<string>? VaultIds { get; set; }

    /// <summary>
    /// Gets or sets the tool list that replaces the agent's own for this session
    /// (<c>agent_with_overrides</c>), or <see langword="null"/> to use the agent as-is.
    /// </summary>
    public IList<JsonElement>? OverrideTools { get; set; }
}
