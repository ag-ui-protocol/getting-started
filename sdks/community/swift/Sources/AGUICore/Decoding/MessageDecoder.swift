// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Decoder for AG-UI protocol messages with polymorphic deserialization.
///
/// `MessageDecoder` decodes JSON message data into strongly-typed message objects based on
/// the "role" field in the JSON. It uses a registry-based architecture matching the pattern
/// used by `AGUIEventDecoder`.
///
/// ## Basic Usage
///
/// ```swift
/// // Create a decoder with default registry
/// let decoder = MessageDecoder()
///
/// // Decode a message from JSON data
/// let message = try decoder.decode(jsonData)
///
/// // Pattern match on the message role
/// switch message.role {
/// case .user:
///     let userMessage = message as! UserMessage
///     print("User said: \(userMessage.content)")
/// case .assistant:
///     let assistantMessage = message as! AssistantMessage
///     print("Assistant replied: \(assistantMessage.content ?? "")")
/// default:
///     print("Other message type: \(message.role)")
/// }
/// ```
///
/// ## Custom Registries
///
/// You can provide a custom registry to control which message types are supported:
///
/// ```swift
/// let customRegistry: [Role: MessageDecoder.DecodeHandler] = [
///     .user: { data, decoder in
///         try UserMessageDTO.decode(from: data, decoder: decoder).toDomain()
///     }
///     // Add more handlers as needed
/// ]
///
/// let decoder = MessageDecoder(registry: customRegistry)
/// ```
///
/// ## Error Handling
///
/// The decoder throws `MessageDecodingError` for various failure scenarios:
///
/// - `.missingRoleField`: The JSON is missing the required "role" field
/// - `.invalidJSON`: The JSON data is malformed or invalid
/// - `.unknownRole(String)`: The role value is not recognized
/// - `.unsupportedRole(Role)`: The role is known but has no handler
/// - `.decodingFailed(String)`: Field-level decoding errors with detailed messages
///
/// ## Thread Safety
///
/// `MessageDecoder` is thread-safe and can be used concurrently. The decoder itself
/// is immutable after initialization.
///
/// - SeeAlso: `Message`, `Role`, `MessageDecodingError`
public struct MessageDecoder: Sendable {

    /// Handler function type for decoding a specific message type.
    ///
    /// Each handler receives the raw JSON data and a `JSONDecoder`, and returns
    /// a decoded `Message` instance.
    ///
    /// - Parameters:
    ///   - data: The raw JSON data for the message
    ///   - decoder: A `JSONDecoder` instance for decoding
    /// - Returns: A decoded `Message` instance
    /// - Throws: `MessageDecodingError` or `DecodingError` if decoding fails
    public typealias DecodeHandler = @Sendable (_ data: Data, _ decoder: JSONDecoder) throws -> any Message

    private let makeDecoder: @Sendable () -> JSONDecoder
    private let registry: [Role: DecodeHandler]

    // MARK: - Initialization

    /// Creates a new `MessageDecoder`.
    ///
    /// - Parameters:
    ///   - makeDecoder: Factory function for creating `JSONDecoder` instances (defaults to standard `JSONDecoder()`)
    ///   - registry: Dictionary mapping roles to their decode handlers (defaults to `defaultRegistry()`)
    ///
    /// The decoder uses the provided registry to determine which message types can be decoded.
    /// If no registry is provided, it uses `defaultRegistry()` which includes all 6 message types.
    public init(
        makeDecoder: @escaping @Sendable () -> JSONDecoder = { JSONDecoder() },
        registry: [Role: DecodeHandler] = MessageDecoder.defaultRegistry()
    ) {
        self.makeDecoder = makeDecoder
        self.registry = registry
    }

    // MARK: - Decoding

    /// Decodes JSON data into a `Message` instance.
    ///
    /// The decoder performs polymorphic deserialization by:
    /// 1. Extracting the "role" field from the JSON
    /// 2. Looking up the appropriate decode handler in the registry
    /// 3. Invoking the handler to decode the message-specific data
    ///
    /// - Parameter data: The JSON data to decode
    /// - Returns: A decoded `Message` instance (specific type depends on the "role" field)
    /// - Throws: `MessageDecodingError` if decoding fails or the role is unknown/unsupported
    ///
    /// Example:
    /// ```swift
    /// let jsonData = """
    /// {
    ///   "id": "msg-1",
    ///   "role": "user",
    ///   "content": "Hello!"
    /// }
    /// """.data(using: .utf8)!
    ///
    /// let decoder = MessageDecoder()
    /// let message = try decoder.decode(jsonData)
    ///
    /// if let userMessage = message as? UserMessage {
    ///     print("User said: \(userMessage.content)")
    /// }
    /// ```
    public func decode(_ data: Data) throws -> any Message {
        let decoder = makeDecoder()

        let role = try decodeRole(from: data, decoder: decoder)

        guard let handler = registry[role] else {
            throw MessageDecodingError.unsupportedRole(role)
        }

        return try executeHandler(handler, data: data, decoder: decoder)
    }

    private func decodeRole(from data: Data, decoder: JSONDecoder) throws -> Role {
        // Extract just the role field
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MessageDecodingError.invalidJSON
        }

        guard let roleString = jsonObject["role"] as? String else {
            throw MessageDecodingError.missingRoleField
        }

        guard let role = Role(rawValue: roleString) else {
            throw MessageDecodingError.unknownRole(roleString)
        }

        return role
    }

    private func executeHandler(
        _ handler: DecodeHandler,
        data: Data,
        decoder: JSONDecoder
    ) throws -> any Message {
        do {
            return try handler(data, decoder)
        } catch let error as MessageDecodingError {
            throw error
        } catch let error as DecodingError {
            throw MessageDecodingError.decodingFailed(error.localizedDescription)
        } catch {
            throw MessageDecodingError.decodingFailed(error.localizedDescription)
        }
    }

    // MARK: - Default Registry

    /// Returns the default registry with handlers for all 7 message types.
    ///
    /// The default registry includes:
    /// - `.developer` → `DeveloperMessage`
    /// - `.system` → `SystemMessage`
    /// - `.user` → `UserMessage`
    /// - `.assistant` → `AssistantMessage`
    /// - `.tool` → `ToolMessage`
    /// - `.activity` → `ActivityMessage`
    /// - `.reasoning` → `ReasoningMessage`
    ///
    /// - Returns: Dictionary mapping each role to its decode handler
    public static func defaultRegistry() -> [Role: DecodeHandler] {
        [
            .developer: { data, decoder in
                try decoder.decode(DeveloperMessage.self, from: data)
            },
            .system: { data, decoder in
                try decoder.decode(SystemMessage.self, from: data)
            },
            .user: { data, decoder in
                try UserMessageDTO.decode(from: data, decoder: decoder).toDomain()
            },
            .assistant: { data, decoder in
                try decoder.decode(AssistantMessage.self, from: data)
            },
            .tool: { data, decoder in
                try ToolMessageDTO.decode(from: data, decoder: decoder).toDomain()
            },
            .activity: { data, decoder in
                try ActivityMessageDTO.decode(from: data, decoder: decoder).toDomain()
            },
            .reasoning: { data, decoder in
                try ReasoningMessageDTO.decode(from: data, decoder: decoder).toDomain()
            }
        ]
    }
}

// MARK: - Message Decoding Error

/// Errors that can occur during message decoding.
public enum MessageDecodingError: Error, Sendable {
    /// The JSON data is invalid or malformed.
    case invalidJSON

    /// The required "role" field is missing from the JSON.
    case missingRoleField

    /// The role value is not a recognized Role case.
    ///
    /// - Parameter roleString: The unrecognized role value
    case unknownRole(String)

    /// The role is recognized but has no registered decode handler.
    ///
    /// This typically indicates the message type isn't supported by the current registry.
    ///
    /// - Parameter role: The unsupported role
    case unsupportedRole(Role)

    /// Decoding failed due to an error in the message data.
    ///
    /// - Parameter message: Description of the decoding failure
    case decodingFailed(String)
}

extension MessageDecodingError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "Invalid JSON data"
        case .missingRoleField:
            return "Missing required 'role' field"
        case .unknownRole(let roleString):
            return "Unknown role: '\(roleString)'"
        case .unsupportedRole(let role):
            return "Unsupported message role: \(role.rawValue)"
        case .decodingFailed(let message):
            return "Message decoding failed: \(message)"
        }
    }
}
