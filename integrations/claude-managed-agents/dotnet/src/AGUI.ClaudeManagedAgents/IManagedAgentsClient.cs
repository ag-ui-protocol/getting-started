using System.Text.Json;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// The slice of the Claude Managed Agents API the integration drives. The default
/// implementation, <see cref="AnthropicManagedAgentsClient"/>, wraps the Anthropic SDK. Provide
/// your own to add caching or telemetry, or to test without the network.
/// </summary>
public interface IManagedAgentsClient
{
    /// <summary>
    /// Creates a managed session and returns its ID.
    /// </summary>
    Task<string> CreateSessionAsync(ManagedAgentSessionRequest request, CancellationToken cancellationToken);

    /// <summary>
    /// Replaces the tool list of the session's agent.
    /// </summary>
    /// <param name="sessionId">The session to update.</param>
    /// <param name="tools">The full replacement tool list, as tool definition JSON objects.</param>
    /// <param name="cancellationToken">A token to cancel the request.</param>
    Task UpdateSessionToolsAsync(string sessionId, IReadOnlyList<JsonElement> tools, CancellationToken cancellationToken);

    /// <summary>
    /// Reads the tools defined on the managed agent itself, as tool definition JSON objects.
    /// </summary>
    /// <param name="managedAgentId">The managed agent to read.</param>
    /// <param name="agentVersion">The agent version to read, or <see langword="null"/> for the latest.</param>
    /// <param name="cancellationToken">A token to cancel the request.</param>
    Task<IReadOnlyList<JsonElement>> GetAgentToolsAsync(string managedAgentId, int? agentVersion, CancellationToken cancellationToken);

    /// <summary>
    /// Posts user events into the session.
    /// </summary>
    /// <param name="sessionId">The session to post to.</param>
    /// <param name="events">The events to post, built with <see cref="ManagedAgentsSessionEvents"/>.</param>
    /// <param name="cancellationToken">A token to cancel the request.</param>
    Task SendEventsAsync(string sessionId, IReadOnlyList<JsonElement> events, CancellationToken cancellationToken);

    /// <summary>
    /// Opens the session's event stream. The returned stream is connected before this task
    /// completes, so no early events are missed.
    /// </summary>
    /// <param name="sessionId">The session to stream.</param>
    /// <param name="streamDeltas">Whether to request text and thinking previews (<c>event_deltas</c>).</param>
    /// <param name="cancellationToken">A token that closes the stream.</param>
    Task<ManagedAgentsEventStream> OpenEventStreamAsync(string sessionId, bool streamDeltas, CancellationToken cancellationToken);
}
