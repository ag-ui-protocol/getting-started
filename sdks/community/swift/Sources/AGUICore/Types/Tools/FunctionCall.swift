// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Represents a function name and its arguments in a tool call.
///
/// `FunctionCall` encapsulates the essential information needed to invoke a function:
/// the function's name and its arguments encoded as a JSON string. This structure
/// provides flexibility in how arguments are structured and validated, deferring
/// parsing and validation to the actual tool execution layer.
///
/// ## Arguments Encoding
///
/// Arguments are stored as a JSON-encoded string rather than a parsed object. This design:
/// - Allows flexibility in argument structures
/// - Defers validation to tool execution time
/// - Supports dynamic function signatures
/// - Maintains compatibility with various serialization formats
///
/// ## Example
///
/// ```swift
/// // Simple function call with basic arguments
/// let weatherCall = FunctionCall(
///     name: "get_weather",
///     arguments: """
///     {
///         "location": "San Francisco",
///         "units": "celsius"
///     }
///     """
/// )
///
/// // Function with no arguments
/// let pingCall = FunctionCall(
///     name: "ping",
///     arguments: "{}"
/// )
///
/// // Parsing arguments at execution time
/// struct WeatherArgs: Codable {
///     let location: String
///     let units: String
/// }
///
/// let argsData = Data(weatherCall.arguments.utf8)
/// let parsedArgs = try JSONDecoder().decode(WeatherArgs.self, from: argsData)
/// ```
///
/// ## Relationship with ToolCall
///
/// `FunctionCall` is typically embedded within a ``ToolCall``, which adds:
/// - A unique identifier for tracking the call
/// - The function type discriminator
///
/// - SeeAlso: ``ToolCall``, ``Tool``
public struct FunctionCall: Sendable, Codable, Hashable {
    /// The name of the function to invoke.
    ///
    /// This should match the name defined in the corresponding ``Tool`` definition.
    /// Function names are typically lowercase with underscores (e.g., "get_weather",
    /// "send_email", "execute_query").
    public let name: String

    /// The function arguments encoded as a JSON string.
    ///
    /// Arguments must be valid JSON. Common patterns:
    /// - Empty arguments: `"{}"`
    /// - Simple arguments: `"{\"location\":\"Paris\"}"`
    /// - Complex arguments: `"{\"filters\":{\"date\":\"2024-01-01\"},\"limit\":100}"`
    ///
    /// The arguments string can be parsed at execution time into a strongly-typed
    /// struct using `JSONDecoder`:
    ///
    /// ```swift
    /// let argsData = Data(functionCall.arguments.utf8)
    /// let parsed = try JSONDecoder().decode(MyArgsType.self, from: argsData)
    /// ```
    public let arguments: String

    /// Creates a new function call.
    ///
    /// - Parameters:
    ///   - name: The name of the function to invoke
    ///   - arguments: The function arguments encoded as a JSON string
    ///
    /// - Note: The arguments parameter should contain valid JSON. Invalid JSON
    ///   will cause errors when the arguments are parsed during execution.
    public init(
        name: String,
        arguments: String
    ) {
        self.name = name
        self.arguments = arguments
    }
}
