namespace AGUI.A2UI;

/// <summary>
/// Prompt-section overrides for the subagent system prompt.
/// </summary>
/// <remarks>
/// Per-field semantics, identical across the sibling toolkits: <see langword="null"/> applies
/// the built-in default block, the empty string suppresses the block entirely, and any other
/// value replaces the default.
/// </remarks>
public sealed class A2UIGuidelines
{
    /// <summary>Gets the protocol/generation rules block override.</summary>
    public string? GenerationGuidelines { get; init; }

    /// <summary>Gets the visual design rules block override.</summary>
    public string? DesignGuidelines { get; init; }

    /// <summary>Gets the host-specific composition guide appended after the context. No built-in default.</summary>
    public string? CompositionGuide { get; init; }
}
