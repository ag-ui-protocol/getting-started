namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class ExecutionCapabilities
{
    public bool? CodeExecution { get; set; }

    public bool? Sandboxed { get; set; }

    public int? MaxIterations { get; set; }

    public int? MaxExecutionTime { get; set; }
}
