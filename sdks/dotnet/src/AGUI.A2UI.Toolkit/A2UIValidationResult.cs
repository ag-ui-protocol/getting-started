namespace AGUI.A2UI;

/// <summary>
/// The outcome of validating an A2UI component tree.
/// </summary>
public sealed class A2UIValidationResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIValidationResult"/> class.
    /// </summary>
    /// <param name="Valid"><see langword="true"/> when no errors were found.</param>
    /// <param name="Errors">The findings, empty when <paramref name="Valid"/> is <see langword="true"/>.</param>
    public A2UIValidationResult(bool Valid, IReadOnlyList<A2UIValidationError> Errors)
    {
        this.Valid = Valid;
        this.Errors = Errors;
    }

    /// <summary>Gets a value indicating whether no errors were found.</summary>
    public bool Valid { get; }

    /// <summary>Gets the findings, empty when <see cref="Valid"/> is <see langword="true"/>.</summary>
    public IReadOnlyList<A2UIValidationError> Errors { get; }
}
