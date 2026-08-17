namespace AGUI.A2UI;

/// <summary>
/// The AG-UI slice of agent state the toolkit reads: forwarded context entries and
/// the component catalog schema, when the host supplied one.
/// </summary>
/// <remarks>
/// Mirrors the <c>state["ag-ui"]</c> contract of the sibling toolkits
/// (<c>context</c> + <c>a2ui_schema</c>). Adapters populate this from the transport,
/// e.g. the AG-UI hosting layer's <c>ag_ui_context</c> additional property.
/// </remarks>
public sealed class A2UIAgentState
{
    /// <summary>
    /// Gets the forwarded AG-UI context entries, when present.
    /// </summary>
    public IReadOnlyList<A2UIContextEntry>? Context { get; init; }

    /// <summary>
    /// Gets the A2UI component catalog schema (serialized JSON), when present.
    /// </summary>
    public string? A2UISchema { get; init; }
}
