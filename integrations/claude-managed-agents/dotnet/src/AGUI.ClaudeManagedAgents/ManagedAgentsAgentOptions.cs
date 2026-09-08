using Anthropic;

namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// Configuration for a <see cref="ManagedAgentsAgent"/>.
/// </summary>
public sealed class ManagedAgentsAgentOptions
{
    /// <summary>
    /// Gets or sets the ID of the managed agent that powers each session. Required.
    /// </summary>
    public string ManagedAgentId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets a pinned agent version. Leave <see langword="null"/> to use the latest at session creation.
    /// </summary>
    public int? AgentVersion { get; set; }

    /// <summary>
    /// Gets or sets the ID of the environment the agent runs in. Required.
    /// </summary>
    public string EnvironmentId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the Anthropic SDK client. Defaults to <c>new AnthropicClient()</c>, which reads
    /// <c>ANTHROPIC_API_KEY</c> (or <c>ANTHROPIC_AUTH_TOKEN</c>). Ignored when <see cref="Client"/> is set.
    /// </summary>
    public IAnthropicClient? AnthropicClient { get; set; }

    /// <summary>
    /// Gets or sets the Managed Agents client. Defaults to an <see cref="AnthropicManagedAgentsClient"/>
    /// over <see cref="AnthropicClient"/>. Set it to substitute the API surface, for example in tests.
    /// </summary>
    public IManagedAgentsClient? Client { get; set; }

    /// <summary>
    /// Gets or sets the thread↔session store. Defaults to an <see cref="InMemorySessionStore"/>.
    /// </summary>
    public ISessionStore? SessionStore { get; set; }

    /// <summary>
    /// Gets the tools the agent can call that this server executes.
    /// </summary>
    public IList<ManagedAgentsBackendTool> BackendTools { get; } = [];

    /// <summary>
    /// Gets or sets the title for newly created sessions. Defaults to <c>AG-UI thread &lt;threadId&gt;</c>.
    /// </summary>
    public Func<string, string>? SessionTitle { get; set; }

    /// <summary>
    /// Gets the vault IDs (<c>vlt_...</c>) for stored credentials the agent may use, attached to
    /// each session this agent creates. Required for MCP servers that authenticate; the API only
    /// accepts them at session creation, so changing them takes effect on new threads.
    /// </summary>
    public IList<string> VaultIds { get; } = [];

    /// <summary>
    /// Gets or sets how to answer a built-in tool gated on user confirmation
    /// (<c>evaluated_permission: "ask"</c>): <see cref="ToolConfirmationPolicy.Allow"/>,
    /// <see cref="ToolConfirmationPolicy.Deny"/>, or <see langword="null"/> (the default) to end
    /// the run with an error instead, since no confirmation UI is wired up yet.
    /// </summary>
    public string? ToolConfirmation { get; set; }

    /// <summary>
    /// Gets or sets the limit after which a turn is interrupted. Defaults to five minutes.
    /// </summary>
    public TimeSpan TurnTimeout { get; set; } = ManagedAgentsLimits.DefaultTurnTimeout;

    /// <summary>
    /// Gets or sets a value indicating whether to request text and thinking previews so replies
    /// stream incrementally. Set to <see langword="false"/> to receive each reply as a whole message
    /// only. Defaults to <see langword="true"/>.
    /// </summary>
    public bool StreamDeltas { get; set; } = true;

    /// <summary>
    /// Gets or sets the handler notified when a best-effort operation fails (an interrupt that
    /// could not be posted, a tool result that could not be delivered). These failures are
    /// deliberately swallowed — they must not fail the run — but without a handler they are also
    /// invisible, leaving an operator with a wedged thread and nothing in the logs.
    /// </summary>
    /// <remarks>
    /// Returns a <see cref="Task"/> so an asynchronous handler can be awaited. An
    /// <see cref="Action"/> would have forced <c>async void</c> on anyone doing asynchronous
    /// telemetry, whose exception escapes to the synchronization context and takes the process
    /// down — the exact opposite of "a broken handler cannot break the run". A synchronous handler
    /// returns <see cref="Task.CompletedTask"/>:
    /// <code>
    /// OnError = (error, context) =>
    /// {
    ///     logger.LogWarning(error, "managed agents: {Operation} failed", context.Operation);
    ///     return Task.CompletedTask;
    /// };
    /// </code>
    /// Exceptions thrown by the handler — synchronously, or from its task — are ignored, as is a
    /// <see langword="null"/> return.
    /// </remarks>
    public Func<Exception, ManagedAgentsErrorContext, Task>? OnError { get; set; }
}
