import '../internal/text.dart';
import '../types/base.dart';

/// Base class for runtime / transport / decoding AG-UI errors.
///
/// Extends the SDK-wide [AGUIError] root in `lib/src/types/base.dart`,
/// so a consumer that catches `on AGUIError` will also catch every
/// `AgUiError` subtype (transport, timeout, decoding, ...) along with
/// `AGUIValidationError` from the factory boundary. Catching
/// `on AgUiError` continues to scope strictly to runtime / transport /
/// decoding — direct factory-side `AGUIValidationError` is NOT caught
/// by `on AgUiError`. See README → "Errors" for the recipe.
abstract class AgUiError extends AGUIError {
  /// Optional error details for debugging
  final Map<String, dynamic>? details;

  /// Original error that caused this error
  final Object? cause;

  const AgUiError(
    super.message, {
    this.details,
    this.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('$runtimeType: $message');
    if (details != null && details!.isNotEmpty) {
      buffer.write(' (details: $details)');
    }
    if (cause != null) {
      buffer.write('\nCaused by: $cause');
    }
    return buffer.toString();
  }
}

/// Error during HTTP/SSE transport operations
class TransportError extends AgUiError {
  /// HTTP status code if applicable
  final int? statusCode;

  /// Request URL/endpoint
  final String? endpoint;

  /// Response body excerpt if available
  final String? responseBody;

  const TransportError(
    super.message, {
    this.statusCode,
    this.endpoint,
    this.responseBody,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('TransportError: $message');
    if (endpoint != null) {
      buffer.write(' (endpoint: $endpoint)');
    }
    if (statusCode != null) {
      buffer.write(' (status: $statusCode)');
    }
    if (responseBody != null) {
      final excerpt = responseBody!.length > 200
          ? '${responseBody!.substring(0, 200)}...'
          : responseBody;
      buffer.write('\nResponse: $excerpt');
    }
    if (cause != null) {
      buffer.write('\nCaused by: $cause');
    }
    return buffer.toString();
  }
}

/// Error when operation times out.
///
/// Renamed from `TimeoutError` to avoid shadowing the built-in
/// `dart:async.TimeoutError` (raised by `Future.timeout(...)` /
/// `Stream.timeout(...)`). A consumer that imports both
/// `package:ag_ui/ag_ui.dart` and `dart:async` would otherwise hit a
/// symbol collision; the README "Errors" recipe used to inadvertently
/// mask the built-in. The old `TimeoutError` name is preserved as a
/// deprecated typedef bridge below — prefer this class.
class AGUITimeoutError extends AgUiError {
  /// Duration that was exceeded
  final Duration? timeout;

  /// Operation that timed out
  final String? operation;

  const AGUITimeoutError(
    super.message, {
    this.timeout,
    this.operation,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('AGUITimeoutError: $message');
    if (operation != null) {
      buffer.write(' (operation: $operation)');
    }
    if (timeout != null) {
      buffer.write(' (timeout: ${timeout!.inSeconds}s)');
    }
    return buffer.toString();
  }
}

/// Deprecated alias for [AGUITimeoutError].
///
/// The bare name `TimeoutError` shadows `dart:async.TimeoutError` when
/// callers import both libraries. Migrate to [AGUITimeoutError]; this
/// alias will be removed in 1.0.0.
@Deprecated(
  'Use AGUITimeoutError. The bare TimeoutError name shadows '
  'dart:async.TimeoutError and will be removed in 1.0.0.',
)
typedef TimeoutError = AGUITimeoutError;

/// Error when operation is cancelled
class CancellationError extends AgUiError {
  /// Operation that was cancelled
  final String? operation;

  /// Reason for cancellation
  final String? reason;

  const CancellationError(
    super.message, {
    this.operation,
    this.reason,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('CancellationError: $message');
    if (operation != null) {
      buffer.write(' (operation: $operation)');
    }
    if (reason != null) {
      buffer.write(' (reason: $reason)');
    }
    return buffer.toString();
  }
}

/// Error decoding JSON or event data
class DecodingError extends AgUiError {
  /// Field or path that failed to decode
  final String? field;

  /// Expected type or format
  final String? expectedType;

  /// Actual value that failed to decode
  final dynamic actualValue;

  const DecodingError(
    super.message, {
    this.field,
    this.expectedType,
    this.actualValue,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('DecodingError: $message');
    if (field != null) {
      buffer.write(' (field: $field)');
    }
    if (expectedType != null) {
      buffer.write(' (expected: $expectedType)');
    }
    if (actualValue != null) {
      buffer.write(' (actual: ${actualValue.runtimeType})');
    }
    if (cause != null) buffer.write('\nCaused by: $cause');
    return buffer.toString();
  }
}

/// Error validating input or output data.
///
/// Thrown by `Validators` (e.g. `Validators.requireNonEmpty`) — not by
/// `fromJson` factories. The factory-side counterpart is
/// `AGUIValidationError` in `lib/src/types/base.dart`, which has a
/// different parent (does NOT extend `AgUiError`). When events flow
/// through the public [EventDecoder] pipeline, both are caught and
/// re-wrapped as `DecodingError`.
class ValidationError extends AgUiError {
  /// Field that failed validation
  final String? field;

  /// Validation constraint that failed
  final String? constraint;

  /// Invalid value
  final dynamic value;

  const ValidationError(
    super.message, {
    this.field,
    this.constraint,
    this.value,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('ValidationError: $message');
    if (field != null) {
      buffer.write(' (field: $field)');
    }
    if (constraint != null) {
      buffer.write(' (constraint: $constraint)');
    }
    if (value != null) {
      final valueStr = value.toString();
      final excerpt = valueStr.length > 100
          ? '${safeTruncate(valueStr, 100)}...'
          : valueStr;
      buffer.write(' (value: $excerpt)');
    }
    if (cause != null) buffer.write('\nCaused by: $cause');
    return buffer.toString();
  }
}

/// Error when protocol rules are violated
class ProtocolViolationError extends AgUiError {
  /// Protocol rule that was violated
  final String? rule;

  /// Current state when violation occurred
  final String? state;

  /// Expected sequence or behavior
  final String? expected;

  const ProtocolViolationError(
    super.message, {
    this.rule,
    this.state,
    this.expected,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('ProtocolViolationError: $message');
    if (rule != null) {
      buffer.write(' (rule: $rule)');
    }
    if (state != null) {
      buffer.write(' (state: $state)');
    }
    if (expected != null) {
      buffer.write(' (expected: $expected)');
    }
    return buffer.toString();
  }
}

/// Server-side application error
class ServerError extends AgUiError {
  /// Error code from server
  final String? errorCode;

  /// Server error type
  final String? errorType;

  /// Server stack trace if available
  final String? stackTrace;

  const ServerError(
    super.message, {
    this.errorCode,
    this.errorType,
    this.stackTrace,
    super.details,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer();
    buffer.write('ServerError: $message');
    if (errorCode != null) {
      buffer.write(' (code: $errorCode)');
    }
    if (errorType != null) {
      buffer.write(' (type: $errorType)');
    }
    if (stackTrace != null) {
      buffer.write('\nStack trace: $stackTrace');
    }
    return buffer.toString();
  }
}

// TODO(1.0.0): Remove the following deprecated typedefs alongside the
// THINKING_TEXT_MESSAGE_* deprecation sweep. Six aliases to delete:
// AgUiHttpException, AgUiConnectionException, AgUiTimeoutException,
// AgUiValidationException, AgUiClientException, TimeoutError.
// Maintain backward compatibility with existing exception types
@Deprecated('Use TransportError instead')
typedef AgUiHttpException = TransportError;

@Deprecated('Use TransportError instead')
typedef AgUiConnectionException = TransportError;

@Deprecated('Use AGUITimeoutError instead')
typedef AgUiTimeoutException = AGUITimeoutError;

@Deprecated('Use ValidationError instead')
typedef AgUiValidationException = ValidationError;

@Deprecated('Use AgUiError instead')
typedef AgUiClientException = AgUiError;
