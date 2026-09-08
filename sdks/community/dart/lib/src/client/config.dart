import '../sse/backoff_strategy.dart';

/// Configuration for AgUiClient.
///
/// Provides configuration options for connecting to AG-UI servers,
/// including timeouts, headers, and retry strategies.
///
/// Example:
/// ```dart
/// final config = AgUiClientConfig(
///   baseUrl: 'http://localhost:8000',
///   defaultHeaders: {'Authorization': 'Bearer token'},
///   maxRetries: 5,
/// );
/// ```
class AgUiClientConfig {
  /// Base URL for the AG-UI server.
  final String baseUrl;

  /// Default headers to include with all requests
  final Map<String, String> defaultHeaders;

  /// Request timeout duration
  final Duration requestTimeout;

  /// Connection timeout for SSE
  final Duration connectionTimeout;

  /// Backoff strategy for retries
  final BackoffStrategy backoffStrategy;

  /// Maximum number of retry attempts
  final int maxRetries;

  /// Whether to include credentials in requests
  final bool withCredentials;

  AgUiClientConfig({
    required this.baseUrl,
    this.defaultHeaders = const {},
    this.requestTimeout = const Duration(seconds: 30),
    this.connectionTimeout = const Duration(seconds: 60),
    BackoffStrategy? backoffStrategy,
    this.maxRetries = 3,
    this.withCredentials = false,
  }) : backoffStrategy = backoffStrategy ?? ExponentialBackoff();

  /// Create a copy with modified fields
  AgUiClientConfig copyWith({
    String? baseUrl,
    Map<String, String>? defaultHeaders,
    Duration? requestTimeout,
    Duration? connectionTimeout,
    BackoffStrategy? backoffStrategy,
    int? maxRetries,
    bool? withCredentials,
  }) {
    return AgUiClientConfig(
      baseUrl: baseUrl ?? this.baseUrl,
      defaultHeaders: defaultHeaders ?? this.defaultHeaders,
      requestTimeout: requestTimeout ?? this.requestTimeout,
      connectionTimeout: connectionTimeout ?? this.connectionTimeout,
      backoffStrategy: backoffStrategy ?? this.backoffStrategy,
      maxRetries: maxRetries ?? this.maxRetries,
      withCredentials: withCredentials ?? this.withCredentials,
    );
  }
}
