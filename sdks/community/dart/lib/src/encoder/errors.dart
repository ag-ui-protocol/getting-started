/// Error types for encoder/decoder operations.
library;

import '../types/base.dart';

/// Base error for encoder/decoder operations.
class EncoderError extends AGUIError {
  /// The source data that caused the error.
  final dynamic source;

  /// The underlying cause of the error, if any.
  final Object? cause;

  EncoderError({
    required String message,
    this.source,
    this.cause,
  }) : super(message);

  @override
  String toString() {
    final buffer = StringBuffer('EncoderError: $message');
    if (source != null) {
      buffer.write('\nSource: $source');
    }
    if (cause != null) {
      buffer.write('\nCause: $cause');
    }
    return buffer.toString();
  }
}

/// Error thrown when decoding fails.
class DecodeError extends EncoderError {
  DecodeError({
    required super.message,
    super.source,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer('DecodeError: $message');
    if (source != null) {
      final sourceStr = source.toString();
      if (sourceStr.length > 200) {
        buffer.write('\nSource (truncated): ${sourceStr.substring(0, 200)}...');
      } else {
        buffer.write('\nSource: $sourceStr');
      }
    }
    if (cause != null) {
      buffer.write('\nCause: $cause');
    }
    return buffer.toString();
  }
}

/// Error thrown when encoding fails.
class EncodeError extends EncoderError {
  EncodeError({
    required super.message,
    super.source,
    super.cause,
  });

  @override
  String toString() {
    final buffer = StringBuffer('EncodeError: $message');
    if (source != null) {
      buffer.write('\nSource: ${source.runtimeType}');
    }
    if (cause != null) {
      buffer.write('\nCause: $cause');
    }
    return buffer.toString();
  }
}

/// Error thrown when validation fails.
class ValidationError extends EncoderError {
  /// The field that failed validation.
  final String? field;

  /// The value that failed validation.
  final dynamic value;

  ValidationError({
    required super.message,
    this.field,
    this.value,
    super.source,
  });

  @override
  String toString() {
    final buffer = StringBuffer('ValidationError: $message');
    if (field != null) {
      buffer.write('\nField: $field');
    }
    if (value != null) {
      buffer.write('\nValue: $value');
    }
    if (source != null) {
      buffer.write('\nSource: $source');
    }
    return buffer.toString();
  }
}
