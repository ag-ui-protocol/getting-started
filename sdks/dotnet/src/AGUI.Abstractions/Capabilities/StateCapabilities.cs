namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class StateCapabilities
{
    public bool? Snapshots { get; set; }

    public bool? Deltas { get; set; }

    public bool? Memory { get; set; }

    public bool? PersistentState { get; set; }
}
