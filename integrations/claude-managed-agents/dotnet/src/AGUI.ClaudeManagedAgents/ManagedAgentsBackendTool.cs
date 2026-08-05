using System.Text.Json;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// A tool the agent may call that this server executes rather than the browser. It is
/// registered on the managed agent as a <c>custom</c> tool; when the agent calls it the
/// integration runs <see cref="Handler"/>, streams the call and its result to the UI, and posts
/// the result back into the session.
/// </summary>
public sealed class ManagedAgentsBackendTool
{
    /// <summary>
    /// Gets or sets the tool name.
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the tool description shown to the agent.
    /// </summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the JSON Schema describing the tool input.
    /// </summary>
    public JsonElement Parameters { get; set; }

    /// <summary>
    /// Gets or sets the handler that executes the tool. It receives the tool input as JSON and
    /// returns the result text posted back to the agent.
    /// </summary>
    public Func<JsonElement, Task<string>> Handler { get; set; } = static _ => Task.FromResult(string.Empty);
}
