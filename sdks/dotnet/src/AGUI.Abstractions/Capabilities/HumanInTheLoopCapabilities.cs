namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class HumanInTheLoopCapabilities
{
    public bool? Supported { get; set; }

    public bool? Approvals { get; set; }

    public bool? Interventions { get; set; }

    public bool? Feedback { get; set; }

    public bool? Interrupts { get; set; }

    public bool? ApproveWithEdits { get; set; }
}
