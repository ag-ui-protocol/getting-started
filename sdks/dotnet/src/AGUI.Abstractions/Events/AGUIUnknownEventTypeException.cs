using System;

namespace AGUI.Abstractions;

/// <summary>
/// Thrown when a decoder meets an event type this SDK does not recognise.
/// </summary>
/// <remarks>
/// The protocol is open at the top: a newer producer may send an event this build has no model
/// for. Stream readers catch this, trace a warning and skip the event, so one unknown entry does
/// not end an otherwise valid stream; decoding a single event surfaces it to the caller instead,
/// because there is nothing to carry on with.
/// </remarks>
public sealed class AGUIUnknownEventTypeException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIUnknownEventTypeException"/> class.
    /// </summary>
    public AGUIUnknownEventTypeException()
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIUnknownEventTypeException"/> class.
    /// </summary>
    /// <param name="message">What went wrong.</param>
    public AGUIUnknownEventTypeException(string message)
        : base(message)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIUnknownEventTypeException"/> class.
    /// </summary>
    /// <param name="message">What went wrong.</param>
    /// <param name="innerException">The exception that caused this one.</param>
    public AGUIUnknownEventTypeException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="AGUIUnknownEventTypeException"/> class.
    /// </summary>
    /// <param name="message">What went wrong.</param>
    /// <param name="eventType">The unrecognised event type, when the wire carried a name for it.</param>
    public AGUIUnknownEventTypeException(string message, string? eventType)
        : base(message)
    {
        EventType = eventType;
    }

    /// <summary>
    /// Gets the unrecognised event type, or <see langword="null"/> when the wire carried no name
    /// for it (a protobuf envelope holding a variant this build was not compiled against).
    /// </summary>
    public string? EventType { get; }
}
