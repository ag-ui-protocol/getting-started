namespace AGUI.ClaudeManagedAgents;

/// <summary>
/// An HTTP failure posting events into a session, for <see cref="IManagedAgentsClient"/>
/// implementations that do not use the Anthropic SDK. Carries the status so the turn can
/// recognize retryable rejections (a session that has not yet un-parked answers a follow-up
/// user message with a 400).
/// </summary>
public sealed class ManagedAgentsSendException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ManagedAgentsSendException"/> class.
    /// </summary>
    /// <param name="statusCode">The HTTP status code the API returned.</param>
    /// <param name="message">The error message from the API.</param>
    /// <param name="innerException">The underlying failure, if any.</param>
    public ManagedAgentsSendException(int statusCode, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        StatusCode = statusCode;
    }

    /// <summary>
    /// Gets the HTTP status code the API returned.
    /// </summary>
    public int StatusCode { get; }
}
