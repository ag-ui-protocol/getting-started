namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class AgentCapabilities
{
    public IdentityCapabilities? Identity { get; set; }

    public TransportCapabilities? Transport { get; set; }

    public ToolsCapabilities? Tools { get; set; }

    public OutputCapabilities? Output { get; set; }

    public StateCapabilities? State { get; set; }

    public MultiAgentCapabilities? MultiAgent { get; set; }

    public ReasoningCapabilities? Reasoning { get; set; }

    public MultimodalCapabilities? Multimodal { get; set; }

    public ExecutionCapabilities? Execution { get; set; }

    public HumanInTheLoopCapabilities? HumanInTheLoop { get; set; }

    public IDictionary<string, object?>? Custom { get; set; }
}
