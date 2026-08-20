using System.Text.Json.Nodes;

namespace AGUI.A2UI;

/// <summary>
/// An inline component catalog used for semantic validation: component schemas
/// (standard JSON Schema fragments with an optional <c>required</c> array) keyed by component name.
/// </summary>
public sealed class A2UIValidationCatalog
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIValidationCatalog"/> class.
    /// </summary>
    /// <param name="components">Component schemas keyed by component name.</param>
    public A2UIValidationCatalog(JsonObject components)
    {
        ArgumentNullException.ThrowIfNull(components);
        this.Components = components;
    }

    /// <summary>
    /// Gets the component schemas keyed by component name.
    /// </summary>
    public JsonObject Components { get; }
}
