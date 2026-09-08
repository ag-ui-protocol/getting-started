/// Represents a Server-Sent Event message.
class SseMessage {
  /// The event type, if specified.
  final String? event;

  /// The event ID, if specified.
  final String? id;

  /// The event data.
  final String? data;

  /// The retry duration suggested by the server.
  final Duration? retry;

  const SseMessage({
    this.event,
    this.id,
    this.data,
    this.retry,
  });

  @override
  String toString() =>
      'SseMessage(event: $event, id: $id, data: $data, retry: $retry)';
}
