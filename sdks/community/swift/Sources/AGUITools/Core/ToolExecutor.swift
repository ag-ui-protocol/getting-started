// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Protocol for executing tools.
///
/// Tool executors are responsible for:
/// - Validating tool call arguments against the tool's schema
/// - Performing the actual tool execution
/// - Handling errors and timeouts
/// - Returning structured results
///
/// Implementations should be:
/// - Thread-safe (multiple concurrent executions via actor isolation)
/// - Idempotent where possible
/// - Defensive (validate all inputs)
/// - Fast (avoid blocking operations when possible)
///
/// ## Usage
///
/// ```swift
/// actor WeatherToolExecutor: ToolExecutor {
///     let tool: Tool
///
///     init() {
///         self.tool = Tool(
///             name: "get_weather",
///             description: "Get current weather for a location",
///             parameters: Data(#"{"type": "object", ...}"#.utf8)
///         )
///     }
///
///     func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
///         // Decode arguments
///         let args = try JSONDecoder().decode(
///             WeatherArgs.self,
///             from: Data(context.toolCall.function.arguments.utf8)
///         )
///
///         // Execute the tool
///         let weather = try await fetchWeather(for: args.location)
///
///         // Return result
///         let resultData = try JSONEncoder().encode(weather)
///         return .success(result: resultData, message: "Weather retrieved")
///     }
///
///     func maximumExecutionTime() -> Duration? {
///         .seconds(30)
///     }
/// }
/// ```
///
/// ## Thread Safety
///
/// Tool executors should be implemented as actors to ensure thread-safe
/// concurrent execution. The protocol requires `Sendable` conformance.
///
/// - SeeAlso: ``ToolExecutionContext``, ``ToolExecutionResult``, ``ToolValidationResult``
public protocol ToolExecutor: Sendable {
    /// The tool definition this executor handles.
    ///
    /// This defines the tool's name, description, and parameter schema that
    /// the executor validates against and executes.
    var tool: Tool { get }

    /// Executes a tool call.
    ///
    /// This is the main execution method that performs the tool's functionality.
    /// Implementations should:
    /// - Parse and validate the tool call arguments
    /// - Perform the requested operation
    /// - Return a structured result or throw an error
    ///
    /// - Parameter context: The execution context including the tool call and metadata
    /// - Returns: The execution result
    /// - Throws: ``ToolExecutionError`` if execution fails in an unrecoverable way
    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult

    /// Validates a tool call before execution.
    ///
    /// This method checks if the tool call arguments are valid according to
    /// the tool's parameter schema. The default implementation returns valid
    /// for all calls. Override to implement custom validation logic.
    ///
    /// - Parameter toolCall: The tool call to validate
    /// - Returns: Validation result with success/failure and error messages
    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult

    /// Gets the maximum execution time for this tool.
    ///
    /// Used by tool registries to implement timeouts. Return nil for no timeout.
    /// Default implementation returns nil.
    ///
    /// - Returns: Maximum execution time, or nil for no timeout
    nonisolated func maximumExecutionTime() -> Duration?
}

// MARK: - Default Implementations

public extension ToolExecutor {
    /// Default validation implementation that accepts all tool calls.
    ///
    /// Override this method to implement custom validation logic based on
    /// your tool's parameter schema.
    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult {
        .valid
    }

    /// Default timeout implementation (no timeout).
    ///
    /// Override this method to specify a maximum execution time for your tool.
    nonisolated func maximumExecutionTime() -> Duration? {
        nil
    }
}

// MARK: - ToolValidationResult

/// Result of tool call validation.
///
/// Indicates whether a tool call's arguments are valid according to the
/// tool's parameter schema, and provides error messages for invalid calls.
///
/// ## Usage
///
/// ```swift
/// // Valid tool call
/// let result = ToolValidationResult.valid
///
/// // Invalid tool call with errors
/// let result = ToolValidationResult.invalid(errors: [
///     "Missing required parameter: location",
///     "Invalid type for parameter 'temperature': expected number"
/// ])
/// ```
public struct ToolValidationResult: Sendable {
    /// Whether the validation passed.
    public let isValid: Bool

    /// Validation error messages (empty if valid).
    ///
    /// Contains human-readable descriptions of validation failures:
    /// - Missing required parameters
    /// - Invalid parameter types
    /// - Schema constraint violations
    /// - Unknown parameters
    public let errors: [String]

    /// Creates a new validation result.
    ///
    /// - Parameters:
    ///   - isValid: Whether the validation passed
    ///   - errors: Validation error messages (empty if valid)
    public init(isValid: Bool, errors: [String] = []) {
        self.isValid = isValid
        self.errors = errors
    }

    /// Creates a successful validation result.
    public static var valid: ToolValidationResult {
        ToolValidationResult(isValid: true, errors: [])
    }

    /// Creates a failed validation result with error messages.
    ///
    /// - Parameter errors: Validation error messages
    /// - Returns: An invalid validation result
    public static func invalid(errors: [String]) -> ToolValidationResult {
        ToolValidationResult(isValid: false, errors: errors)
    }
}

// MARK: - ToolExecutionError

/// Errors that can occur during tool execution.
///
/// This enum categorizes different types of tool execution failures to enable
/// appropriate error handling, retry logic, and user feedback.
///
/// ## Error Categories
///
/// - **validationFailed**: Tool call arguments are invalid (user error, not retryable)
/// - **timeout**: Execution exceeded maximum time (may be retryable)
/// - **toolNotFound**: Requested tool doesn't exist (configuration error, not retryable)
/// - **executionFailed**: General execution failure (may be retryable depending on cause)
///
/// ## Usage
///
/// ```swift
/// // Validation failure
/// throw ToolExecutionError.validationFailed(
///     message: "Missing required parameter: location"
/// )
///
/// // Timeout
/// throw ToolExecutionError.timeout(
///     toolName: "slow_api_call",
///     duration: .seconds(30)
/// )
///
/// // Execution failure with underlying error
/// do {
///     try await apiCall()
/// } catch {
///     throw ToolExecutionError.executionFailed(
///         toolName: "api_tool",
///         underlyingError: error
///     )
/// }
/// ```
public enum ToolExecutionError: Error, Sendable {
    /// Tool call validation failed.
    ///
    /// Indicates that the tool call arguments are invalid according to the
    /// tool's parameter schema. This is typically a user error and not retryable.
    ///
    /// - Parameter message: Description of the validation failure
    case validationFailed(message: String)

    /// Tool execution exceeded the maximum allowed time.
    ///
    /// Indicates that the tool took longer than its configured timeout.
    /// This may be a transient error and could be worth retrying.
    ///
    /// - Parameters:
    ///   - toolName: Name of the tool that timed out
    ///   - duration: How long the tool was allowed to run
    case timeout(toolName: String, duration: Duration)

    /// Requested tool was not found in the registry.
    ///
    /// Indicates a configuration error where the agent requested a tool
    /// that doesn't exist or wasn't registered. This is not retryable.
    ///
    /// - Parameter toolName: Name of the tool that wasn't found
    case toolNotFound(toolName: String)

    /// Tool execution failed with an error.
    ///
    /// General execution failure that wraps an underlying error. Whether
    /// this is retryable depends on the nature of the underlying error.
    ///
    /// - Parameters:
    ///   - toolName: Name of the tool that failed
    ///   - underlyingError: The underlying error that caused the failure
    case executionFailed(toolName: String, underlyingError: any Error & Sendable)
}
