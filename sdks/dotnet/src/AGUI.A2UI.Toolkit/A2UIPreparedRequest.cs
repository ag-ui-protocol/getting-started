namespace AGUI.A2UI;

/// <summary>
/// The outcome of preparing an A2UI generation request: the assembled subagent prompt
/// plus the resolved create/update intent.
/// </summary>
public sealed class A2UIPreparedRequest
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIPreparedRequest"/> class.
    /// </summary>
    /// <param name="Prompt">The subagent system prompt; empty when <paramref name="Error"/> is set.</param>
    /// <param name="IsUpdate">Whether the request edits an existing surface.</param>
    /// <param name="Prior">The prior surface state on the update path.</param>
    /// <param name="Error">A host-facing error when preparation failed (e.g. update target not found).</param>
    public A2UIPreparedRequest(string Prompt, bool IsUpdate, A2UIPriorSurface? Prior, string? Error)
    {
        this.Prompt = Prompt;
        this.IsUpdate = IsUpdate;
        this.Prior = Prior;
        this.Error = Error;
    }

    /// <summary>Gets the subagent system prompt; empty when <see cref="Error"/> is set.</summary>
    public string Prompt { get; }

    /// <summary>Gets a value indicating whether the request edits an existing surface.</summary>
    public bool IsUpdate { get; }

    /// <summary>Gets the prior surface state on the update path.</summary>
    public A2UIPriorSurface? Prior { get; }

    /// <summary>Gets a host-facing error when preparation failed (e.g. update target not found).</summary>
    public string? Error { get; }
}
