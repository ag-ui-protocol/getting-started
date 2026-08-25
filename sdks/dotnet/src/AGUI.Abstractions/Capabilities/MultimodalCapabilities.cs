namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class MultimodalCapabilities
{
    public MultimodalInputCapabilities? Input { get; set; }

    public MultimodalOutputCapabilities? Output { get; set; }
}
