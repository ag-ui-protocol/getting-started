namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class MultimodalInputCapabilities
{
    public bool? Image { get; set; }

    public bool? Audio { get; set; }

    public bool? Video { get; set; }

    public bool? Pdf { get; set; }

    public bool? File { get; set; }
}
