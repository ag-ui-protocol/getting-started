namespace AGUI.A2UI;

/// <summary>
/// Error codes emitted by <see cref="A2UIComponentValidator"/>.
/// </summary>
/// <remarks>
/// The string values are part of the cross-language A2UI contract (shared with the
/// TypeScript and Python toolkits) and feed back into subagent retry prompts; they
/// must not diverge from the sibling implementations.
/// </remarks>
public static class A2UIValidationErrorCodes
{
    /// <summary>The component set is missing or empty.</summary>
    public const string EmptyComponents = "empty_components";

    /// <summary>A component has no usable string <c>id</c>.</summary>
    public const string MissingId = "missing_id";

    /// <summary>A component has no usable string <c>component</c> type.</summary>
    public const string MissingComponentType = "missing_component_type";

    /// <summary>Two or more components share the same <c>id</c>.</summary>
    public const string DuplicateId = "duplicate_id";

    /// <summary>No component carries the mandatory <c>id</c> of <c>"root"</c>.</summary>
    public const string NoRoot = "no_root";

    /// <summary>A component type is not present in the supplied catalog.</summary>
    public const string UnknownComponent = "unknown_component";

    /// <summary>A component lacks a property the catalog marks as required.</summary>
    public const string MissingRequiredProp = "missing_required_prop";

    /// <summary>A child reference points at a component id that does not exist.</summary>
    public const string UnresolvedChild = "unresolved_child";

    /// <summary>A component participates in a child-reference cycle; the child/children tree must be a DAG.</summary>
    public const string ChildCycle = "child_cycle";

    /// <summary>An absolute data binding path does not resolve in the data model.</summary>
    public const string UnresolvedBinding = "unresolved_binding";
}
