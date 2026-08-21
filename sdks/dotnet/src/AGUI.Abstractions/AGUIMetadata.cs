namespace AGUI.Abstractions;

/// <summary>
/// Constants for the metadata object carried by every event and message.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/metadata.ts
public static class AGUIMetadata
{
    /// <summary>
    /// The key reserved for AG-UI's own use inside a metadata object. Every
    /// other key is user space.
    /// </summary>
    /// <remarks>
    /// Reservation is by convention: nothing rejects a write to this key at
    /// runtime, because metadata is open by key and validating its shape would
    /// contradict that.
    /// </remarks>
    public const string ReservedKey = "ag-ui";
}
