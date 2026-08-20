namespace AGUI.A2UI;

/// <summary>
/// A conversation-history message as seen by the surface walker. Adapters map their
/// framework's message type onto this shape; only tool-result messages with string
/// content participate in surface reconstruction.
/// </summary>
public sealed class A2UIHistoryMessage
{
    /// <summary>
    /// Initializes a new instance of the <see cref="A2UIHistoryMessage"/> class.
    /// </summary>
    /// <param name="Role">The message role; tool results carry <c>"tool"</c>.</param>
    /// <param name="Content">The raw message content.</param>
    public A2UIHistoryMessage(string? Role, string? Content)
    {
        this.Role = Role;
        this.Content = Content;
    }

    /// <summary>Gets the message role; tool results carry <c>"tool"</c>.</summary>
    public string? Role { get; }

    /// <summary>Gets the raw message content.</summary>
    public string? Content { get; }
}
