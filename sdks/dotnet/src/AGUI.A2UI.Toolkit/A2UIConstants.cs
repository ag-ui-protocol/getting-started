
namespace AGUI.A2UI;

/// <summary>
/// Shared constants for the A2UI toolkit, mirroring the canonical values used by the
/// TypeScript (<c>@ag-ui/a2ui-toolkit</c>) and Python (<c>ag-ui-a2ui-toolkit</c>) implementations.
/// </summary>
/// <remarks>
/// These values are part of the cross-language A2UI wire contract and must not diverge
/// from the sibling implementations.
/// </remarks>
public static class A2UIConstants
{
    /// <summary>
    /// The JSON key that wraps an array of A2UI operations in a tool result envelope.
    /// AG-UI middlewares scan tool results for this key to detect renderable surfaces.
    /// </summary>
    public const string A2UIOperationsKey = "a2ui_operations";

    /// <summary>
    /// The catalog identifier of the A2UI v0.9 basic component catalog.
    /// Used as the default catalog when the host does not configure one.
    /// </summary>
    public const string BasicCatalogId = "https://a2ui.org/specification/v0_9/basic_catalog.json";

    /// <summary>
    /// The fallback surface identifier used when the model output does not carry a usable one.
    /// </summary>
    public const string DefaultSurfaceId = "dynamic-surface";

    /// <summary>
    /// The protocol version stamped on every emitted A2UI operation.
    /// </summary>
    public const string ProtocolVersion = "v0.9";

    /// <summary>
    /// The default name of the planner-facing tool that delegates surface generation to a subagent.
    /// </summary>
    public const string GenerateA2UIToolName = "generate_a2ui";

    /// <summary>
    /// The name of the inner structured-output tool the subagent is forced to call.
    /// </summary>
    public const string RenderA2UIToolName = "render_a2ui";

    /// <summary>
    /// The default maximum number of generation attempts in the validate-and-retry recovery loop.
    /// </summary>
    public const int MaxA2UIAttempts = 3;

    /// <summary>
    /// The activity type identifier reserved for the A2UI recovery status channel. Part of
    /// the cross-language wire contract (it mirrors the TypeScript toolkit's
    /// <c>A2UI_RECOVERY_ACTIVITY_TYPE</c>); pinned here so adapters and tests can reference it.
    /// </summary>
    public const string A2UIRecoveryActivityType = "a2ui_recovery";

    /// <summary>
    /// The description the AG-UI A2UI middleware uses for the context entry that carries
    /// the component catalog schema. Adapters match this description to route the catalog
    /// into the subagent prompt's "Available Components" section.
    /// </summary>
    public const string A2UISchemaContextDescription =
        "A2UI Component Schema — available components for generating UI surfaces. " +
        "Use these component names and properties when creating A2UI operations.";
}
