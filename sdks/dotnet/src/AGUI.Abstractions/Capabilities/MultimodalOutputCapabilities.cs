namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class MultimodalOutputCapabilities
{
    public bool? Image { get; set; }

    public bool? Audio { get; set; }
}
