using System.Collections.Generic;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class OutputCapabilities
{
    public bool? StructuredOutput { get; set; }

    public IList<string>? SupportedMimeTypes { get; set; }
}
