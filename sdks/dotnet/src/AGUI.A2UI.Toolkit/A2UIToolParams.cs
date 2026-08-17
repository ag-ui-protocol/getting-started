namespace AGUI.A2UI;

/// <summary>
/// Shared behavior knobs for A2UI tool factories. Every framework adapter accepts this
/// exact shape, so a new knob reaches all adapters without signature changes.
/// </summary>
/// <remarks>
/// Mirrors <c>A2UIToolParams</c> in the sibling toolkits, minus the <c>model</c> field:
/// in .NET the subagent chat client is a framework concern owned by the adapter's own
/// factory signature, not by this parameter object.
/// </remarks>
public sealed class A2UIToolParams
{
    /// <summary>Gets the prompt-section overrides.</summary>
    public A2UIGuidelines? Guidelines { get; init; }

    /// <summary>Gets the fallback surface id. Empty or unset falls back to <see cref="A2UIConstants.DefaultSurfaceId"/>.</summary>
    public string? DefaultSurfaceId { get; init; }

    /// <summary>Gets the catalog id for created surfaces. Empty or unset falls back to <see cref="A2UIConstants.BasicCatalogId"/>.</summary>
    public string? DefaultCatalogId { get; init; }

    /// <summary>Gets the planner-facing tool name. Empty or unset falls back to <see cref="A2UIConstants.GenerateA2UIToolName"/>.</summary>
    public string? ToolName { get; init; }

    /// <summary>Gets the planner-facing tool description. Empty or unset falls back to the canonical description.</summary>
    public string? ToolDescription { get; init; }

    /// <summary>Gets the catalog used for semantic validation in the recovery loop.</summary>
    public A2UIValidationCatalog? Catalog { get; init; }

    /// <summary>Gets the recovery-loop configuration.</summary>
    public A2UIRecoveryConfig? Recovery { get; init; }

    /// <summary>Gets the per-attempt observability callback.</summary>
    public Action<A2UIAttemptRecord>? OnAttempt { get; init; }
}
