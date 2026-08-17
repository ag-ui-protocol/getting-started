namespace AGUI.A2UI;

/// <summary>
/// <see cref="A2UIToolParams"/> with every defaultable field resolved to its effective value.
/// </summary>
public sealed class A2UIResolvedToolParams
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIResolvedToolParams"/> class.
    /// </summary>
    /// <param name="Guidelines">The prompt-section overrides, passed through.</param>
    /// <param name="DefaultSurfaceId">The effective fallback surface id.</param>
    /// <param name="DefaultCatalogId">The effective default catalog id.</param>
    /// <param name="ToolName">The effective planner-facing tool name.</param>
    /// <param name="ToolDescription">The effective planner-facing tool description.</param>
    /// <param name="Catalog">The validation catalog, passed through.</param>
    /// <param name="Recovery">The recovery configuration, passed through.</param>
    /// <param name="OnAttempt">The per-attempt callback, passed through.</param>
    public A2UIResolvedToolParams(
        A2UIGuidelines? Guidelines,
        string DefaultSurfaceId,
        string DefaultCatalogId,
        string ToolName,
        string ToolDescription,
        A2UIValidationCatalog? Catalog,
        A2UIRecoveryConfig? Recovery,
        Action<A2UIAttemptRecord>? OnAttempt)
    {
        this.Guidelines = Guidelines;
        this.DefaultSurfaceId = DefaultSurfaceId;
        this.DefaultCatalogId = DefaultCatalogId;
        this.ToolName = ToolName;
        this.ToolDescription = ToolDescription;
        this.Catalog = Catalog;
        this.Recovery = Recovery;
        this.OnAttempt = OnAttempt;
    }

    /// <summary>Gets the prompt-section overrides, passed through.</summary>
    public A2UIGuidelines? Guidelines { get; }

    /// <summary>Gets the effective fallback surface id.</summary>
    public string DefaultSurfaceId { get; }

    /// <summary>Gets the effective default catalog id.</summary>
    public string DefaultCatalogId { get; }

    /// <summary>Gets the effective planner-facing tool name.</summary>
    public string ToolName { get; }

    /// <summary>Gets the effective planner-facing tool description.</summary>
    public string ToolDescription { get; }

    /// <summary>Gets the validation catalog, passed through.</summary>
    public A2UIValidationCatalog? Catalog { get; }

    /// <summary>Gets the recovery configuration, passed through.</summary>
    public A2UIRecoveryConfig? Recovery { get; }

    /// <summary>Gets the per-attempt callback, passed through.</summary>
    public Action<A2UIAttemptRecord>? OnAttempt { get; }
}
