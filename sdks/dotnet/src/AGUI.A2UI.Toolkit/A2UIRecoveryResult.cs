namespace AGUI.A2UI;

/// <summary>
/// The outcome of the A2UI generation recovery loop.
/// </summary>
public sealed class A2UIRecoveryResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIRecoveryResult"/> class.
    /// </summary>
    /// <param name="Envelope">
    /// The operations envelope on success, or a structured hard-failure envelope
    /// (<c>code: "a2ui_recovery_exhausted"</c>) when all attempts failed.
    /// </param>
    /// <param name="Attempts">The per-attempt records, in order.</param>
    /// <param name="Ok">Whether a valid surface was produced.</param>
    public A2UIRecoveryResult(string Envelope, IReadOnlyList<A2UIAttemptRecord> Attempts, bool Ok)
    {
        this.Envelope = Envelope;
        this.Attempts = Attempts;
        this.Ok = Ok;
    }

    /// <summary>
    /// Gets the operations envelope on success, or a structured hard-failure envelope
    /// (<c>code: "a2ui_recovery_exhausted"</c>) when all attempts failed.
    /// </summary>
    public string Envelope { get; }

    /// <summary>Gets the per-attempt records, in order.</summary>
    public IReadOnlyList<A2UIAttemptRecord> Attempts { get; }

    /// <summary>Gets a value indicating whether a valid surface was produced.</summary>
    public bool Ok { get; }
}
