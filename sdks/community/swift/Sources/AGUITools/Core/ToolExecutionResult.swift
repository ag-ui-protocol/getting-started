// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Result of a tool execution.
///
/// `ToolExecutionResult` encapsulates the outcome of executing a tool, including
/// success/failure status, optional result data, and optional human-readable messages.
/// This type supports both successful outcomes with data and failed outcomes with
/// error information.
///
/// ## Usage
///
/// ```swift
/// // Successful execution with data
/// let jsonData = Data(#"{"temperature": 72, "conditions": "sunny"}"#.utf8)
/// let result = ToolExecutionResult.success(
///     result: jsonData,
///     message: "Weather retrieved successfully"
/// )
///
/// // Failed execution
/// let error = ToolExecutionResult.failure(
///     message: "Failed to connect to weather service"
/// )
/// ```
///
/// ## Design Notes
///
/// - Result data is stored as `Data` (JSON) to maintain flexibility
/// - Both success and failure cases can include optional messages
/// - Conforms to `Sendable` for safe concurrent access
/// - Conforms to `Equatable` for testing and comparison
///
/// - SeeAlso: ``ToolExecutor``, ``ToolExecutionContext``
public struct ToolExecutionResult: Sendable, Equatable {
    /// Whether the tool execution was successful.
    public let success: Bool

    /// The result data (if successful) or error information (if failed).
    ///
    /// This is typically JSON-encoded data. For successful executions, it contains
    /// the tool's output. For failed executions, it may contain structured error details.
    public let result: Data?

    /// Optional human-readable message about the result.
    ///
    /// For successful executions, this might describe what was accomplished.
    /// For failed executions, this typically contains an error message.
    public let message: String?

    /// Creates a new tool execution result.
    ///
    /// - Parameters:
    ///   - success: Whether the execution was successful
    ///   - result: Optional result data (typically JSON)
    ///   - message: Optional human-readable message
    public init(
        success: Bool,
        result: Data? = nil,
        message: String? = nil
    ) {
        self.success = success
        self.result = result
        self.message = message
    }

    /// Creates a successful execution result.
    ///
    /// - Parameters:
    ///   - result: Optional result data (typically JSON)
    ///   - message: Optional success message
    /// - Returns: A successful execution result
    public static func success(
        result: Data? = nil,
        message: String? = nil
    ) -> ToolExecutionResult {
        ToolExecutionResult(success: true, result: result, message: message)
    }

    /// Creates a failed execution result.
    ///
    /// - Parameters:
    ///   - message: Error message describing the failure
    ///   - result: Optional error data (typically JSON with error details)
    /// - Returns: A failed execution result
    public static func failure(
        message: String,
        result: Data? = nil
    ) -> ToolExecutionResult {
        ToolExecutionResult(success: false, result: result, message: message)
    }

    /// Decodes the result data as the given `Decodable` type.
    ///
    /// ```swift
    /// let weather = try result.decode(as: WeatherResponse.self)
    /// ```
    ///
    /// - Parameters:
    ///   - type: The target `Decodable` type.
    ///   - decoder: The JSON decoder to use (defaults to `JSONDecoder()`).
    /// - Returns: The decoded value, or `nil` when `result` is `nil`.
    /// - Throws: `DecodingError` if the data cannot be decoded as `T`.
    public func decode<T: Decodable>(
        as type: T.Type,
        using decoder: JSONDecoder = JSONDecoder()
    ) throws -> T? {
        guard let data = result else { return nil }
        return try decoder.decode(T.self, from: data)
    }
}
