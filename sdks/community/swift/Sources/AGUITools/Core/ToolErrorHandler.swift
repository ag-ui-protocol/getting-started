// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - RetryStrategy

/// Strategy for calculating retry delays.
public enum RetryStrategy: Sendable {
    /// Constant delay between retries.
    case fixed
    /// Delay grows linearly with attempt count.
    case linear
    /// Delay grows exponentially with attempt count.
    case exponential
    /// Exponential delay with random jitter to prevent thundering herd.
    case exponentialJitter
}

// MARK: - CircuitBreakerState

/// State of the circuit breaker.
public enum CircuitBreakerState: Sendable {
    /// Circuit is closed — requests flow normally.
    case closed
    /// Circuit is open — requests are rejected immediately.
    case open
    /// Circuit is probing — one request allowed to test recovery.
    case halfOpen
}

// MARK: - CircuitBreakerConfig

/// Configuration for a ``CircuitBreaker``.
public struct CircuitBreakerConfig: Sendable {
    /// Number of failures before opening the circuit. Default: 5.
    public var failureThreshold: Int
    /// Seconds to wait in OPEN state before trying HALF_OPEN. Default: 60.
    public var recoveryTimeoutSeconds: TimeInterval
    /// Number of successes in HALF_OPEN state to close the circuit. Default: 2.
    public var successThreshold: Int

    public init(
        failureThreshold: Int = 5,
        recoveryTimeoutSeconds: TimeInterval = 60,
        successThreshold: Int = 2
    ) {
        self.failureThreshold = failureThreshold
        self.recoveryTimeoutSeconds = recoveryTimeoutSeconds
        self.successThreshold = successThreshold
    }
}

// MARK: - CircuitBreaker

/// Thread-safe circuit breaker actor.
///
/// Prevents cascading failures by rejecting calls when a tool is consistently failing.
/// Transitions between three states:
/// - **closed**: Normal operation; requests are allowed through.
/// - **open**: Failure threshold exceeded; requests are rejected immediately.
/// - **halfOpen**: Recovery probe; one request is allowed through to test recovery.
///
/// ## State Machine
///
/// ```
/// closed  ──(failures >= threshold)──► open
///   ▲                                    │
///   └──(successes >= threshold)──  ◄─── │ (recovery timeout elapsed)
///                              halfOpen ◄┘
/// ```
public actor CircuitBreaker {
    private let config: CircuitBreakerConfig
    private var state: CircuitBreakerState = .closed
    private var failureCount: Int = 0
    private var successCount: Int = 0
    private var lastFailureTime: Date?

    /// Creates a new circuit breaker with the given configuration.
    ///
    /// - Parameter config: Circuit breaker configuration.
    public init(config: CircuitBreakerConfig = CircuitBreakerConfig()) {
        self.config = config
    }

    /// Returns the current circuit breaker state.
    public func currentState() -> CircuitBreakerState { state }

    /// Returns `true` if the next call should be allowed through, `false` if rejected.
    ///
    /// When the circuit is `open`, this method transitions to `halfOpen` once the
    /// recovery timeout has elapsed.
    public func allowRequest() -> Bool {
        switch state {
        case .closed:
            return true
        case .open:
            guard let lastFailure = lastFailureTime,
                  Date().timeIntervalSince(lastFailure) >= config.recoveryTimeoutSeconds
            else {
                return false
            }
            state = .halfOpen
            successCount = 0
            return true
        case .halfOpen:
            return true
        }
    }

    /// Records a successful call and updates state accordingly.
    ///
    /// In `halfOpen`, accumulates successes until the threshold is met and
    /// the circuit transitions back to `closed`.
    public func recordSuccess() {
        switch state {
        case .halfOpen:
            successCount += 1
            if successCount >= config.successThreshold {
                state = .closed
                failureCount = 0
                successCount = 0
            }
        case .closed:
            failureCount = 0
        case .open:
            break
        }
    }

    /// Records a failed call and updates state accordingly.
    ///
    /// In `closed`, accumulates failures until the threshold is met and
    /// the circuit transitions to `open`. In `halfOpen`, any failure immediately
    /// re-opens the circuit.
    public func recordFailure() {
        lastFailureTime = Date()
        switch state {
        case .closed:
            failureCount += 1
            if failureCount >= config.failureThreshold {
                state = .open
            }
        case .halfOpen:
            state = .open
            successCount = 0
        case .open:
            break
        }
    }

    /// Resets the circuit breaker to the `closed` state.
    public func reset() {
        state = .closed
        failureCount = 0
        successCount = 0
        lastFailureTime = nil
    }
}

// MARK: - ToolErrorConfig

/// Configuration for ``ToolErrorHandler``.
public struct ToolErrorConfig: Sendable {
    /// Maximum number of retry attempts. Default: 3.
    public var maxRetryAttempts: Int
    /// Base delay in milliseconds for retry calculations. Default: 1000.
    public var baseRetryDelayMs: Int64
    /// Maximum delay cap in milliseconds. Default: 30000.
    public var maxRetryDelayMs: Int64
    /// Retry delay strategy. Default: `.exponentialJitter`.
    public var retryStrategy: RetryStrategy
    /// Whether to retry on tool-not-found errors. Default: `false`.
    public var retryOnNotFound: Bool
    /// Whether to retry on validation errors. Default: `false`.
    public var retryOnValidation: Bool
    /// Circuit breaker configuration.
    public var circuitBreaker: CircuitBreakerConfig

    public init(
        maxRetryAttempts: Int = 3,
        baseRetryDelayMs: Int64 = 1000,
        maxRetryDelayMs: Int64 = 30_000,
        retryStrategy: RetryStrategy = .exponentialJitter,
        retryOnNotFound: Bool = false,
        retryOnValidation: Bool = false,
        circuitBreaker: CircuitBreakerConfig = CircuitBreakerConfig()
    ) {
        self.maxRetryAttempts = maxRetryAttempts
        self.baseRetryDelayMs = baseRetryDelayMs
        self.maxRetryDelayMs = maxRetryDelayMs
        self.retryStrategy = retryStrategy
        self.retryOnNotFound = retryOnNotFound
        self.retryOnValidation = retryOnValidation
        self.circuitBreaker = circuitBreaker
    }
}

// MARK: - ToolErrorDecision

/// Decision returned by ``ToolErrorHandler/handleError(error:context:attempt:)``.
public enum ToolErrorDecision: Sendable {
    /// Retry the tool call after the specified delay (nanoseconds).
    case retry(delayNanoseconds: UInt64)
    /// Fail immediately with the given error message.
    case fail(message: String)
    /// Circuit breaker is open; reject without retrying.
    case circuitOpen
}

// MARK: - ToolErrorHandler

/// Handles tool execution errors with retry logic and circuit-breaker protection.
///
/// `ToolErrorHandler` combines a configurable retry strategy with a ``CircuitBreaker``
/// to prevent cascading failures. On each error, it decides whether to retry (and after
/// what delay), fail immediately, or reject because the circuit is open.
///
/// ## Example
///
/// ```swift
/// let handler = ToolErrorHandler()
///
/// func executeWithRetry(
///     context: ToolExecutionContext,
///     executor: any ToolExecutor
/// ) async throws -> ToolExecutionResult {
///     var attempt = 0
///     while true {
///         do {
///             let result = try await executor.execute(context: context)
///             await handler.recordSuccess()
///             return result
///         } catch {
///             let decision = await handler.handleError(
///                 error: error,
///                 context: context,
///                 attempt: attempt
///             )
///             switch decision {
///             case .retry(let delayNs):
///                 try await Task.sleep(nanoseconds: delayNs)
///                 attempt += 1
///             case .fail(let message):
///                 throw ToolExecutionError.executionFailed(
///                     toolName: context.toolCall.function.name,
///                     underlyingError: ToolExecutionError.validationFailed(message: message)
///                 )
///             case .circuitOpen:
///                 throw ToolExecutionError.executionFailed(
///                     toolName: context.toolCall.function.name,
///                     underlyingError: ToolExecutionError.validationFailed(message: "Circuit breaker open")
///                 )
///             }
///         }
///     }
/// }
/// ```
public actor ToolErrorHandler {
    private let config: ToolErrorConfig
    private let circuitBreaker: CircuitBreaker

    /// Creates a new error handler with the given configuration.
    ///
    /// - Parameter config: Configuration controlling retry behaviour and the circuit breaker.
    public init(config: ToolErrorConfig = ToolErrorConfig()) {
        self.config = config
        self.circuitBreaker = CircuitBreaker(config: config.circuitBreaker)
    }

    // MARK: - Public Interface

    /// Evaluates an error and returns what to do next.
    ///
    /// Call this method after every failed tool execution. Pass the zero-based
    /// `attempt` index so the handler can compute an appropriate back-off delay
    /// and enforce the maximum retry limit.
    ///
    /// - Parameters:
    ///   - error: The error from the tool execution.
    ///   - context: The execution context for the failed call.
    ///   - attempt: Zero-based retry attempt index (0 = first failure).
    /// - Returns: ``ToolErrorDecision`` indicating whether to retry, fail, or reject.
    public func handleError(
        error: Error,
        context: ToolExecutionContext,
        attempt: Int
    ) async -> ToolErrorDecision {
        // Reject immediately when the circuit is open.
        guard await circuitBreaker.allowRequest() else {
            return .circuitOpen
        }

        // Record the failure so the circuit breaker can track state.
        await circuitBreaker.recordFailure()

        let isRetryable = shouldRetry(error: error)

        guard isRetryable, attempt < config.maxRetryAttempts else {
            return .fail(message: error.localizedDescription)
        }

        let delayMs = calculateDelay(attempt: attempt)
        let delayNs = UInt64(delayMs) * 1_000_000
        return .retry(delayNanoseconds: delayNs)
    }

    /// Records a successful execution for circuit breaker state management.
    ///
    /// Call this after every successful tool execution so the circuit breaker
    /// can track recovery in ``CircuitBreakerState/halfOpen`` state.
    public func recordSuccess() async {
        await circuitBreaker.recordSuccess()
    }

    /// Returns the current circuit breaker state.
    public func circuitBreakerState() async -> CircuitBreakerState {
        await circuitBreaker.currentState()
    }

    /// Resets the circuit breaker to the `closed` state.
    ///
    /// Useful in tests or after a known-bad period has ended.
    public func resetCircuitBreaker() async {
        await circuitBreaker.reset()
    }

    // MARK: - Private Helpers

    /// Determines whether the given error is eligible for a retry attempt.
    private func shouldRetry(error: Error) -> Bool {
        // ToolRegistryError.toolNotFound — not retryable unless explicitly configured.
        if let registryError = error as? ToolRegistryError {
            switch registryError {
            case .toolNotFound:
                return config.retryOnNotFound
            case .alreadyRegistered, .emptyToolName:
                return false
            }
        }

        // ToolExecutionError — varies by case.
        if let execError = error as? ToolExecutionError {
            switch execError {
            case .validationFailed:
                return config.retryOnValidation
            case .toolNotFound:
                return config.retryOnNotFound
            case .timeout, .executionFailed:
                return true
            }
        }

        // Retry all other errors by default.
        return true
    }

    /// Calculates the retry delay in milliseconds for the given attempt index.
    private func calculateDelay(attempt: Int) -> Int64 {
        let base = config.baseRetryDelayMs
        let maxDelay = config.maxRetryDelayMs

        let delay: Int64
        switch config.retryStrategy {
        case .fixed:
            delay = base

        case .linear:
            delay = base * Int64(attempt + 1)

        case .exponential:
            let multiplier = Int64(pow(2.0, Double(attempt)))
            delay = base * multiplier

        case .exponentialJitter:
            let multiplier = Int64(pow(2.0, Double(attempt)))
            let exponential = base * multiplier
            let jitter = Int64.random(in: 0 ... (exponential / 2))
            delay = exponential + jitter
        }

        return min(delay, maxDelay)
    }
}
