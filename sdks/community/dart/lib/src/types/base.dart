/// Base types for AG-UI protocol models.
///
/// This library provides the foundational types and utilities for the AG-UI
/// protocol implementation in Dart.
library;

import 'dart:convert';

import '../internal/text.dart';

/// Base class for all AG-UI models with JSON serialization support.
///
/// All protocol models extend this class to provide consistent JSON
/// serialization and deserialization capabilities.
abstract class AGUIModel {
  const AGUIModel();

  /// Converts this model to a JSON map.
  Map<String, dynamic> toJson();

  /// Converts this model to a JSON string.
  String toJsonString() => json.encode(toJson());

  /// Creates a copy of this model with optional field updates.
  /// Subclasses should override this with their specific type.
  AGUIModel copyWith();
}

/// Mixin for models with type discriminators.
///
/// Used by event and message types to provide a type field for
/// polymorphic deserialization.
mixin TypeDiscriminator {
  /// The type discriminator field value.
  String get type;
}

/// Base exception for AG-UI protocol errors.
///
/// The root exception class for all AG-UI protocol-related errors.
/// `AgUiError` (lib/src/client/errors.dart) and [AGUIValidationError]
/// both extend this class — so callers can catch the entire SDK error
/// surface with `on AGUIError`. Catching `on AgUiError` covers
/// transport / decoder / runtime errors but NOT direct-factory
/// `AGUIValidationError`. See README → "Errors" for the catch-recipe.
class AGUIError implements Exception {
  /// Human-readable error message.
  final String message;

  const AGUIError(this.message);

  @override
  String toString() => 'AGUIError: $message';
}

/// Represents a validation error during JSON decoding.
///
/// Thrown by `fromJson` factories at the wire-decoding boundary. Extends
/// [AGUIError] so `on AGUIError` catches both factory-side and
/// runtime-side failures uniformly. The separate `ValidationError` in
/// `lib/src/client/errors.dart` is thrown by `Validators.requireNonEmpty`
/// inside `EventDecoder.validate`. When events are decoded through the
/// public [EventDecoder] pipeline, both classes are caught and re-thrown
/// as `DecodingError` — see `decoder.dart` for the wrapping logic. Direct
/// callers of `Event.fromJson` see this `AGUIValidationError` directly.
class AGUIValidationError extends AGUIError {
  final String? field;
  final dynamic value;

  /// The originating JSON payload that failed validation.
  ///
  /// **Sensitive-data warning.** This carries the entire wire payload
  /// the factory was given, including cipher fields like
  /// `encryptedValue` / `encrypted_value` on the
  /// `REASONING_ENCRYPTED_VALUE` / `ToolMessage` / `ReasoningMessage` /
  /// `BaseMessage` decode paths. The default `toString()` does NOT emit
  /// this field, so error printing is safe by default — but consumers
  /// that reflect-serialize errors (e.g.
  /// `log.error('decode failed', extra: {'error': error})` with a
  /// reflection-based serializer) will leak the cipher payload. For
  /// log lines shipped to external sinks, prefer [field] and [value]
  /// over [json].
  final Map<String, dynamic>? json;

  /// Originating exception, if this validation error was raised in
  /// response to another error (e.g. a wrong-typed field caught inside a
  /// `transform` callback). Preserves structured info that would
  /// otherwise be flattened by `'$e'` interpolation.
  final Object? cause;

  const AGUIValidationError({
    required String message,
    this.field,
    this.value,
    this.json,
    this.cause,
  }) : super(message);

  @override
  String toString() {
    final buffer = StringBuffer('AGUIValidationError: $message');
    if (field != null) buffer.write(' (field: $field)');
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

/// Utility for tolerant JSON decoding that ignores unknown fields.
///
/// Provides helper methods for safely extracting and validating fields
/// from JSON maps, with proper error handling.
///
/// camelCase/snake_case parity is handled by [requireEitherField] and
/// [optionalEitherField] for keys whose two spellings differ —
/// e.g. `messageId` / `message_id`, `toolCallId` / `tool_call_id`,
/// `parentRunId` / `parent_run_id`. Single-word keys whose camelCase and
/// snake_case spellings are identical (`delta`, `name`, `title`,
/// `replace`, `content`, `value`, `event`, `source`, `code`, `subtype`,
/// `messages`, `patch`, `snapshot`, `role`, `result`, `input`,
/// `timestamp`, `details`, `error`, `state`) are read with the bare
/// [requireField] / [optionalField] helpers — they don't need
/// `*EitherField` because there's no second spelling to fall back to.
class JsonDecoder {
  /// Safely extracts a required field from JSON.
  static T requireField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? transform,
  }) {
    if (!json.containsKey(field)) {
      throw AGUIValidationError(
        message: 'Missing required field',
        field: field,
        json: json,
      );
    }

    final value = json[field];
    if (value == null) {
      throw AGUIValidationError(
        message: 'Required field is null',
        field: field,
        value: value,
        json: json,
      );
    }

    if (transform != null) {
      try {
        return transform(value);
      } on AGUIError {
        rethrow;
      } catch (e) {
        throw AGUIValidationError(
          message: 'Failed to transform field: $e',
          field: field,
          value: value,
          json: json,
          cause: e,
        );
      }
    }

    if (value is! T) {
      throw AGUIValidationError(
        message:
            'Field has incorrect type. Expected $T, got ${value.runtimeType}',
        field: field,
        value: value,
        json: json,
      );
    }

    return value;
  }

  /// Safely extracts an optional field from JSON.
  static T? optionalField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? transform,
  }) {
    if (!json.containsKey(field) || json[field] == null) {
      return null;
    }

    final value = json[field];

    if (transform != null) {
      try {
        return transform(value);
      } on AGUIError {
        rethrow;
      } catch (e) {
        throw AGUIValidationError(
          message: 'Failed to transform field: $e',
          field: field,
          value: value,
          json: json,
          cause: e,
        );
      }
    }

    if (value is! T) {
      throw AGUIValidationError(
        message:
            'Field has incorrect type. Expected $T, got ${value.runtimeType}',
        field: field,
        value: value,
        json: json,
      );
    }

    return value;
  }

  /// Reads a required field that may arrive under either of two keys.
  ///
  /// Servers in this protocol use camelCase (TypeScript) or snake_case
  /// (Python) field names interchangeably. Resolution is by KEY PRESENCE
  /// via `containsKey` — matching the rule documented on
  /// [optionalEitherField]:
  ///   • If [camelKey] is present (even when its value is explicitly
  ///     `null`), [camelKey] wins and [snakeKey] is NOT consulted.
  ///   • [snakeKey] is consulted ONLY when [camelKey] is entirely absent.
  ///
  /// If neither key resolves to a non-null value, throws an
  /// [AGUIValidationError] naming BOTH keys — avoiding the misleading
  /// "missing message_id" error when the caller actually sent `messageId`.
  ///
  /// Note on short-circuit behavior: if [camelKey] is present but holds
  /// a wrong-typed value, [optionalField] throws and the [snakeKey]
  /// fallback is NOT attempted — a payload that carries both keys with
  /// conflicting types is a protocol violation, and surfacing the type
  /// error at [camelKey] is more useful than silently rescuing via the
  /// snake_case alias. The same rule applies to [optionalEitherField].
  static T requireEitherField<T>(
    Map<String, dynamic> json,
    String camelKey,
    String snakeKey,
  ) {
    if (json.containsKey(camelKey)) {
      final v = optionalField<T>(json, camelKey);
      if (v == null) {
        throw AGUIValidationError(
          message: 'Required field "$camelKey" is present but null',
          field: camelKey,
          json: json,
        );
      }
      return v;
    }
    if (json.containsKey(snakeKey)) {
      final v = optionalField<T>(json, snakeKey);
      if (v == null) {
        throw AGUIValidationError(
          message: 'Required field "$snakeKey" is present but null',
          field: snakeKey,
          json: json,
        );
      }
      return v;
    }
    throw AGUIValidationError(
      message: 'Missing required field "$camelKey" (or "$snakeKey")',
      field: camelKey,
      json: json,
    );
  }

  /// Reads an optional field that may arrive under either of two keys.
  ///
  /// Resolution is by KEY presence, matching the contract documented on
  /// [requireEitherField]: if `camelKey` is present in `json` (even when
  /// its value is explicitly `null`), the camelCase value wins.
  /// `snakeKey` is consulted only when `camelKey` is entirely absent.
  ///
  /// This `containsKey` rule replaced the prior `??`-chain implementation,
  /// which fell through to `snakeKey` whenever the camelCase value was
  /// `null`-or-absent — silently overriding an explicit-null camelCase
  /// payload with a populated snake_case one.
  ///
  /// **Error field name note.** When the snake_case path is taken (camelKey
  /// absent) and a type mismatch occurs, [optionalField] reports the error
  /// using [snakeKey] as the field name — the wire spelling, not the
  /// canonical camelCase name. Callers that need to report the canonical
  /// name in error messages should catch [AGUIValidationError] and remap
  /// `field` to [camelKey] themselves.
  ///
  /// **Consumer guidance for error-driven field routing.** If you write an
  /// error handler that matches on `e.field` to route errors by field name
  /// (e.g. `if (e.field == 'toolCallId') ...`), be aware that the error may
  /// carry the snake_case spelling (`'tool_call_id'`) when the Python-side wire
  /// payload was the one that failed validation. Match both spellings or use
  /// a prefix/contains check to stay wire-format agnostic.
  static T? optionalEitherField<T>(
    Map<String, dynamic> json,
    String camelKey,
    String snakeKey,
  ) {
    if (json.containsKey(camelKey)) {
      return optionalField<T>(json, camelKey);
    }
    return optionalField<T>(json, snakeKey);
  }

  /// Reads an optional integer field, accepting either `int` or `num`
  /// on the wire.
  ///
  /// JS/TS producers serialize all numbers through a single Number type,
  /// so a server emitting `Date.now() / 1000` (or any fractional value)
  /// arrives in Dart as `double`. `optionalField<int>` rejects that with
  /// `AGUIValidationError` even when the value is integer-shaped. This
  /// helper accepts any `num` and coerces via `.floor()`, matching
  /// TS `Math.floor` rounding semantics (rounds toward −∞ for negative
  /// values, identical to `.toInt()` for non-negative).
  ///
  /// Non-finite `num` values (`NaN`, `±Infinity`) are rejected with an
  /// `AGUIValidationError` rather than letting `.floor()` throw a raw
  /// `UnsupportedError` — keeping all decode failures in the AG-UI error
  /// hierarchy.
  static int? optionalIntField(
    Map<String, dynamic> json,
    String field,
  ) {
    if (!json.containsKey(field) || json[field] == null) return null;
    final value = json[field];
    if (value is num) {
      if (value.isNaN || value.isInfinite) {
        throw AGUIValidationError(
          message: 'Field is non-finite (NaN or Infinity)',
          field: field,
          value: value,
          json: json,
        );
      }
      // Guard BEFORE the `is int` fast-return: on Dart-on-JS every number is
      // a 64-bit double, so `1.0 is int` is `true`. Without this ordering the
      // 2^53 check would be bypassed for any double-valued integer that happens
      // to pass `is int` — the guard must come first so the range check always
      // executes regardless of platform. 2^53 is the largest integer exactly
      // representable as a 64-bit IEEE 754 double.
      const maxSafeInt = 9007199254740992; // 2^53
      if (value > maxSafeInt || value < -maxSafeInt) {
        throw AGUIValidationError(
          message: 'Field value out of safe int range (±2^53)',
          field: field,
          value: value,
          json: json,
        );
      }
      if (value is int) return value;
      return value.floor();
    }
    throw AGUIValidationError(
      message:
          'Field has incorrect type. Expected int or num, got ${value.runtimeType}',
      field: field,
      value: value,
      json: json,
    );
  }

  /// Cipher-safe variant of [optionalIntField].
  ///
  /// Identical in behavior but intentionally omits `json:` from every thrown
  /// [AGUIValidationError]. Use this on event factories (e.g.
  /// `ReasoningEncryptedValueEvent.fromJson`) where the `json` map may contain
  /// an `encryptedValue` cipher field. Including `json:` on those error paths
  /// would surface the raw cipher payload via
  /// `AGUIValidationError.json` — the exact leakage that
  /// `_requireCipherSafeString` and the factory's `rawEvent: null` pin are
  /// designed to prevent.
  ///
  /// **All cipher-safe helpers a new cipher-bearing event factory must use:**
  /// - [_requireCipherSafeString] — required string field without json: leak
  /// - [optionalCipherSafeIntField] — optional int field without json: leak
  /// - Set `rawEvent: null` unconditionally in the factory return (or
  ///   conditionally via a `hasCipher` predicate like MessagesSnapshotEvent)
  /// - Throw [AGUIValidationError] without `json:` on every error path
  ///
  /// If a new helper is needed for a different type (e.g. cipher-safe bool or
  /// list), add it here with an identical json:-omitting pattern and list it
  /// in this block.
  static int? optionalCipherSafeIntField(
    Map<String, dynamic> json,
    String field,
  ) {
    if (!json.containsKey(field) || json[field] == null) return null;
    final value = json[field];
    if (value is num) {
      if (value.isNaN || value.isInfinite) {
        throw AGUIValidationError(
          message: 'Field is non-finite (NaN or Infinity)',
          field: field,
          value: value,
          // Intentionally omit json: — payload may carry cipher data.
        );
      }
      const maxSafeInt = 9007199254740992; // 2^53
      if (value > maxSafeInt || value < -maxSafeInt) {
        throw AGUIValidationError(
          message: 'Field value out of safe int range (±2^53)',
          field: field,
          value: value,
          // Intentionally omit json: — payload may carry cipher data.
        );
      }
      if (value is int) return value;
      return value.floor();
    }
    throw AGUIValidationError(
      message:
          'Field has incorrect type. Expected int or num, got ${value.runtimeType}',
      field: field,
      value: value,
      // Intentionally omit json: — payload may carry cipher data.
    );
  }

  /// Safely extracts a list field from JSON.
  ///
  /// Use this when the elements have a concrete element type that the SDK
  /// strongly types (`requireListField<Map<String, dynamic>>` for nested
  /// records, etc.) — the inner per-element type check provides the type
  /// safety. Wrong-typed elements raise [AGUIValidationError] eagerly with
  /// `field: '$field[$i]'` so the decoder pipeline can preserve the
  /// originating index instead of flattening to a generic `field: 'json'`.
  /// For loosely-typed payloads where the elements are intentionally
  /// `dynamic`, prefer `requireField<List<dynamic>>` to avoid an
  /// unnecessary check.
  static List<T> requireListField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? itemTransform,
  }) {
    final list = requireField<List<dynamic>>(json, field);

    if (itemTransform != null) {
      final out = <T>[];
      for (var i = 0; i < list.length; i++) {
        try {
          out.add(itemTransform(list[i]));
        } catch (e) {
          throw AGUIValidationError(
            message: 'Failed to transform list item',
            field: '$field[$i]',
            value: list[i],
            json: json,
            cause: e,
          );
        }
      }
      return out;
    }

    return _eagerCast<T>(list, field, json); // view, not copy
  }

  /// Safely extracts an optional list field from JSON.
  ///
  /// Mirrors [requireListField]'s eager element-type validation when no
  /// transform is supplied, so a malformed list element raises
  /// [AGUIValidationError] with the originating index instead of leaking
  /// a `TypeError` to the decoder catch-all.
  static List<T>? optionalListField<T>(
    Map<String, dynamic> json,
    String field, {
    T Function(dynamic)? itemTransform,
  }) {
    final list = optionalField<List<dynamic>>(json, field);
    if (list == null) return null;

    if (itemTransform != null) {
      final out = <T>[];
      for (var i = 0; i < list.length; i++) {
        try {
          out.add(itemTransform(list[i]));
        } catch (e) {
          throw AGUIValidationError(
            message: 'Failed to transform list item',
            field: '$field[$i]',
            value: list[i],
            json: json,
            cause: e,
          );
        }
      }
      return out;
    }

    return _eagerCast<T>(list, field, json); // view, not copy
  }

  /// Reads an optional list field that may arrive under either of two
  /// keys, with the same eager element-type validation as
  /// [optionalListField] / [requireListField].
  ///
  /// Composes the dual-key resolution rule from [optionalEitherField]
  /// (camelCase wins when present, even when the list is empty; snake_case
  /// is consulted ONLY when camelCase is absent) with the index-aware
  /// element-type errors from [_eagerCast]. Use this when a list-shaped
  /// field has both camelCase and snake_case wire spellings AND the
  /// elements have a concrete type the SDK strongly types.
  ///
  /// The behavior matches [optionalListField] when [itemTransform] is
  /// supplied: the transform is wrapped in a per-element try/catch
  /// producing an [AGUIValidationError] with `field: '$resolvedKey[$i]'`.
  /// Without [itemTransform], element type mismatches are reported with
  /// `field: '$camelKey[$i]'`.
  static List<T>? optionalEitherListField<T>(
    Map<String, dynamic> json,
    String camelKey,
    String snakeKey, {
    T Function(dynamic)? itemTransform,
  }) {
    // Resolve the wire spelling BEFORE calling optionalEitherField so that
    // error messages produced by _eagerCast (and itemTransform errors) use
    // the key that was actually present on the wire — matching the contract
    // documented on optionalEitherField (snakeKey wins when camelKey absent).
    final resolvedKey = json.containsKey(camelKey) ? camelKey : snakeKey;
    final list = optionalEitherField<List<dynamic>>(json, camelKey, snakeKey);
    if (list == null) return null;

    if (itemTransform != null) {
      final out = <T>[];
      for (var i = 0; i < list.length; i++) {
        try {
          out.add(itemTransform(list[i]));
        } catch (e) {
          throw AGUIValidationError(
            message: 'Failed to transform list item',
            field: '$resolvedKey[$i]',
            value: list[i],
            json: json,
            cause: e,
          );
        }
      }
      return out;
    }

    return _eagerCast<T>(list, resolvedKey, json); // view, not copy
  }

  /// Eagerly validates element types in a list and returns a typed view.
  ///
  /// Replaces `list.cast<T>()`'s lazy view (which raises a raw `TypeError`
  /// at access time, swallowed by the decoder catch-all and flattened to
  /// `field: 'json'`) with a fail-fast loop that names the bad index.
  ///
  /// **Field-naming convention**: errors report `'$field[$i]'` (e.g.
  /// `"messages[2]"`). Per-factory list decoders that re-wrap validation
  /// errors from nested factories use a more precise `'$field[$i].$nestedField'`
  /// form (e.g. `"messages[2].role"`) — `_eagerCast` cannot do this
  /// because it only checks the element's Dart type, not its internal shape.
  ///
  /// **View semantics**: returns a lazy `cast<T>()` view over the original
  /// `List<dynamic>`, not a new copy. This avoids a second O(n) allocation
  /// on hot paths (MESSAGES_SNAPSHOT, StateDelta, etc.), but callers must
  /// not mutate the original list after receiving the view — a mutation that
  /// introduces a wrong-typed element would bypass this validation and raise
  /// a raw `TypeError` at access time. All current call sites consume the
  /// result immediately and do not retain the original reference.
  static List<T> _eagerCast<T>(
    List<dynamic> list,
    String field,
    Map<String, dynamic> json,
  ) {
    // Validate-then-cast: iterate once to emit structured errors, then return
    // a lazy cast view instead of copying into a new list — avoids a second
    // O(n) allocation on the hot path (MESSAGES_SNAPSHOT, StateDelta, etc.).
    for (var i = 0; i < list.length; i++) {
      final item = list[i];
      if (item is! T) {
        throw AGUIValidationError(
          message:
              'List item has incorrect type. Expected $T, got ${item.runtimeType}',
          field: '$field[$i]',
          value: item,
          json: json,
        );
      }
    }
    return list.cast<T>();
  }
}

/// Shared sentinel for `copyWith` methods across all AG-UI type families.
///
/// Each copyWith that guards a nullable field uses `Object? field = kUnsetSentinel`
/// and checks `identical(field, kUnsetSentinel)` to distinguish "argument
/// omitted" (preserve current value) from "argument explicitly null" (clear
/// the field). The class is private to prevent re-construction — the only valid
/// sentinel is this canonical constant.
class _CopyWithSentinel {
  const _CopyWithSentinel();
}

/// Single shared sentinel instance used across all AG-UI `copyWith` methods.
///
/// This constant IS part of the public API — it is exported from `ag_ui.dart`.
/// The backing type ([_CopyWithSentinel]) is intentionally private to prevent
/// re-construction; the only valid sentinel is this canonical constant.
///
/// External consumers can use `identical(field, kUnsetSentinel)` to test for
/// the sentinel, but cannot declare method parameters with the private backing
/// type in their own libraries. To implement sentinel semantics in an external
/// `copyWith`, declare the parameter as `Object?` and test with
/// `identical(field, kUnsetSentinel)`:
/// ```dart
/// MyType copyWith({Object? nullableField = kUnsetSentinel}) {
///   final resolved = identical(nullableField, kUnsetSentinel)
///       ? this.nullableField
///       : nullableField as TargetType?;
///   return MyType(nullableField: resolved);
/// }
/// ```
const _CopyWithSentinel kUnsetSentinel = _CopyWithSentinel();

/// Converts snake_case to camelCase
String snakeToCamel(String snake) {
  final parts = snake.split('_');
  if (parts.isEmpty) return snake;

  return parts.first +
      parts
          .skip(1)
          .map((part) =>
              part.isEmpty ? '' : part[0].toUpperCase() + part.substring(1))
          .join();
}

/// Converts camelCase to snake_case
String camelToSnake(String camel) {
  return camel
      .replaceAllMapped(
        RegExp(r'[A-Z]'),
        (match) => '_${match.group(0)!.toLowerCase()}',
      )
      .replaceFirst(RegExp(r'^_'), '');
}
