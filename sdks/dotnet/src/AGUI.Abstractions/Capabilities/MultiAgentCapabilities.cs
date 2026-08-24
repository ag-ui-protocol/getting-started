using System.Collections.Generic;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class MultiAgentCapabilities
{
    public bool? Supported { get; set; }

    public bool? Delegation { get; set; }

    public bool? Handoffs { get; set; }

    public IList<SubAgentInfo>? SubAgents { get; set; }
}
