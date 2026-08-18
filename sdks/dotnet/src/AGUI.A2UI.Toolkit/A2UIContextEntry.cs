namespace AGUI.A2UI;

/// <summary>
/// One AG-UI context entry as forwarded to the agent (description/value pair).
/// </summary>
public sealed class A2UIContextEntry
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIContextEntry"/> class.
    /// </summary>
    /// <param name="Description">The optional section heading for the entry.</param>
    /// <param name="Value">The entry content.</param>
    public A2UIContextEntry(string? Description, string? Value)
    {
        this.Description = Description;
        this.Value = Value;
    }

    /// <summary>Gets the optional section heading for the entry.</summary>
    public string? Description { get; }

    /// <summary>Gets the entry content.</summary>
    public string? Value { get; }
}
