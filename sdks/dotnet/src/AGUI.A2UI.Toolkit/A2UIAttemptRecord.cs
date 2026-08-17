namespace AGUI.A2UI;

/// <summary>
/// One attempt of the A2UI validate-and-retry generation loop.
/// </summary>
public sealed class A2UIAttemptRecord
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIAttemptRecord"/> class.
    /// </summary>
    /// <param name="Attempt">The 1-based attempt number.</param>
    /// <param name="Ok">Whether the attempt produced a valid component tree.</param>
    /// <param name="Errors">The validation errors when <paramref name="Ok"/> is <see langword="false"/>.</param>
    public A2UIAttemptRecord(int Attempt, bool Ok, IReadOnlyList<A2UIValidationError> Errors)
    {
        this.Attempt = Attempt;
        this.Ok = Ok;
        this.Errors = Errors;
    }

    /// <summary>Gets the 1-based attempt number.</summary>
    public int Attempt { get; }

    /// <summary>Gets a value indicating whether the attempt produced a valid component tree.</summary>
    public bool Ok { get; }

    /// <summary>Gets the validation errors when <see cref="Ok"/> is <see langword="false"/>.</summary>
    public IReadOnlyList<A2UIValidationError> Errors { get; }
}
