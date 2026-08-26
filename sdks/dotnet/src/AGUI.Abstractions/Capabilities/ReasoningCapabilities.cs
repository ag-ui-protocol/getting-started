namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class ReasoningCapabilities
{
    public bool? Supported { get; set; }

    public bool? Streaming { get; set; }

    public bool? Encrypted { get; set; }
}
