namespace AGUI.A2UI;

/// <summary>
/// A single semantic validation finding for an A2UI component tree.
/// </summary>
public sealed class A2UIValidationError
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIValidationError"/> class.
    /// </summary>
    /// <param name="Code">One of the <see cref="A2UIValidationErrorCodes"/> values.</param>
    /// <param name="Path">A JSON-pointer-style location, e.g. <c>components[1].rating</c>.</param>
    /// <param name="Message">A human/model-readable description used in retry prompts.</param>
    public A2UIValidationError(string Code, string Path, string Message)
    {
        this.Code = Code;
        this.Path = Path;
        this.Message = Message;
    }

    /// <summary>Gets one of the <see cref="A2UIValidationErrorCodes"/> values.</summary>
    public string Code { get; }

    /// <summary>Gets a JSON-pointer-style location, e.g. <c>components[1].rating</c>.</summary>
    public string Path { get; }

    /// <summary>Gets a human/model-readable description used in retry prompts.</summary>
    public string Message { get; }
}
