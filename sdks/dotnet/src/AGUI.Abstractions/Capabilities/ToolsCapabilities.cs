using System.Collections.Generic;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class ToolsCapabilities
{
    public bool? Supported { get; set; }

    public IList<AGUITool>? Items { get; set; }

    public bool? ParallelCalls { get; set; }

    public bool? ClientProvided { get; set; }
}
