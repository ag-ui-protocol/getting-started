using System.Text.Json.Nodes;

namespace AGUI.A2UI;

/// <summary>
/// The reconstructed end state of a previously rendered surface, used to seed
/// update-intent prompts and envelopes.
/// </summary>
public sealed class A2UIPriorSurface
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIPriorSurface"/> class.
    /// </summary>
    /// <param name="Components">The last known component array, when seen.</param>
    /// <param name="Data">The last known data model, when seen. May be <see langword="null"/>.</param>
    /// <param name="CatalogId">The catalog the surface was created against, when seen.</param>
    public A2UIPriorSurface(JsonArray? Components, JsonNode? Data, string? CatalogId)
    {
        this.Components = Components;
        this.Data = Data;
        this.CatalogId = CatalogId;
    }

    /// <summary>Gets the last known component array, when seen.</summary>
    public JsonArray? Components { get; }

    /// <summary>Gets the last known data model, when seen. May be <see langword="null"/>.</summary>
    public JsonNode? Data { get; }

    /// <summary>Gets the catalog the surface was created against, when seen.</summary>
    public string? CatalogId { get; }
}
