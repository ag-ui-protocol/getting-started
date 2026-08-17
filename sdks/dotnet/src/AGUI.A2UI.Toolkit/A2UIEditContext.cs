namespace AGUI.A2UI;

/// <summary>
/// The prior-surface context injected into the prompt when editing an existing surface.
/// </summary>
public sealed class A2UIEditContext
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIEditContext"/> class.
    /// </summary>
    /// <param name="SurfaceId">The id of the surface being edited.</param>
    /// <param name="Prior">The reconstructed prior surface state.</param>
    /// <param name="Changes">An optional natural-language description of the requested changes.</param>
    public A2UIEditContext(string SurfaceId, A2UIPriorSurface Prior, string? Changes = null)
    {
        this.SurfaceId = SurfaceId;
        this.Prior = Prior;
        this.Changes = Changes;
    }

    /// <summary>Gets the id of the surface being edited.</summary>
    public string SurfaceId { get; }

    /// <summary>Gets the reconstructed prior surface state.</summary>
    public A2UIPriorSurface Prior { get; }

    /// <summary>Gets an optional natural-language description of the requested changes.</summary>
    public string? Changes { get; }
}
