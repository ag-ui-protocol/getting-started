// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Encoder for AG-UI protocol messages with polymorphic serialization.
///
/// `MessageEncoder` encodes strongly-typed message objects into JSON data based on
/// the message's role. It uses a registry-based architecture matching the pattern
/// used by `MessageDecoder`.
///
/// ## Basic Usage
///
/// ```swift
/// // Create an encoder with default registry
/// let encoder = MessageEncoder()
///
/// // Encode a message to JSON data
/// let message = UserMessage(id: "msg-1", content: "Hello!")
/// let jsonData = try encoder.encode(message)
///
/// // Convert to string for viewing
/// let jsonString = String(data: jsonData, encoding: .utf8)
/// ```
///
/// ## Custom Registries
///
/// You can provide a custom registry to control how message types are encoded:
///
/// ```swift
/// let customRegistry: [Role: MessageEncoder.EncodeHandler] = [
///     .user: { message, encoder in
///         let userMessage = message as! UserMessage
///         // Custom encoding logic
///         return customEncoding(userMessage)
///     }
/// ]
///
/// let encoder = MessageEncoder(registry: customRegistry)
/// ```
///
/// ## Error Handling
///
/// The encoder throws `MessageEncodingError` for various failure scenarios:
///
/// - `.unsupportedRole(Role)`: The message role has no registered encoder
/// - `.invalidMessageType(Role, String)`: Message type doesn't match its role
/// - `.encodingFailed(String)`: Field-level encoding errors
///
/// ## Thread Safety
///
/// `MessageEncoder` is thread-safe and can be used concurrently. The encoder itself
/// is immutable after initialization.
///
/// - SeeAlso: `Message`, `Role`, `MessageDecoder`
public struct MessageEncoder: Sendable {

    /// Handler function type for encoding a specific message type.
    ///
    /// Each handler receives a message and a `JSONEncoder`, and returns
    /// encoded JSON data.
    ///
    /// - Parameters:
    ///   - message: The message to encode
    ///   - encoder: A `JSONEncoder` instance for encoding
    /// - Returns: Encoded JSON data
    /// - Throws: `MessageEncodingError` or `EncodingError` if encoding fails
    public typealias EncodeHandler = @Sendable (_ message: any Message, _ encoder: JSONEncoder) throws -> Data

    private let makeEncoder: @Sendable () -> JSONEncoder
    private let registry: [Role: EncodeHandler]

    // MARK: - Initialization

    /// Creates a new `MessageEncoder`.
    ///
    /// - Parameters:
    ///   - makeEncoder: Factory function for creating `JSONEncoder` instances (defaults to standard `JSONEncoder()`)
    ///   - registry: Dictionary mapping roles to their encode handlers (defaults to `defaultRegistry()`)
    ///
    /// The encoder uses the provided registry to determine how message types should be encoded.
    /// If no registry is provided, it uses `defaultRegistry()` which includes all 6 message types.
    public init(
        makeEncoder: @escaping @Sendable () -> JSONEncoder = { JSONEncoder() },
        registry: [Role: EncodeHandler] = MessageEncoder.defaultRegistry()
    ) {
        self.makeEncoder = makeEncoder
        self.registry = registry
    }

    // MARK: - Encoding

    /// Encodes a `Message` instance into JSON data.
    ///
    /// The encoder performs polymorphic serialization by:
    /// 1. Determining the message's role
    /// 2. Looking up the appropriate encode handler in the registry
    /// 3. Invoking the handler to encode the message-specific data
    ///
    /// - Parameter message: The message to encode
    /// - Returns: JSON data representing the message
    /// - Throws: `MessageEncodingError` if encoding fails or the role is unsupported
    ///
    /// Example:
    /// ```swift
    /// let encoder = MessageEncoder()
    /// let message = UserMessage(id: "msg-1", content: "Hello!")
    /// let jsonData = try encoder.encode(message)
    /// ```
    public func encode(_ message: any Message) throws -> Data {
        let encoder = makeEncoder()
        let role = message.role

        guard let handler = registry[role] else {
            throw MessageEncodingError.unsupportedRole(role)
        }

        return try executeHandler(handler, message: message, encoder: encoder)
    }

    private func executeHandler(
        _ handler: EncodeHandler,
        message: any Message,
        encoder: JSONEncoder
    ) throws -> Data {
        do {
            return try handler(message, encoder)
        } catch let error as MessageEncodingError {
            throw error
        } catch let error as EncodingError {
            throw MessageEncodingError.encodingFailed(error.localizedDescription)
        } catch {
            throw MessageEncodingError.encodingFailed(error.localizedDescription)
        }
    }

    // MARK: - Default Registry

    /// Returns the default registry with handlers for all 7 message types.
    ///
    /// The default registry includes:
    /// - `.developer` → Encodes `DeveloperMessage`
    /// - `.system` → Encodes `SystemMessage`
    /// - `.user` → Encodes `UserMessage`
    /// - `.assistant` → Encodes `AssistantMessage`
    /// - `.tool` → Encodes `ToolMessage`
    /// - `.activity` → Encodes `ActivityMessage`
    /// - `.reasoning` → Encodes `ReasoningMessage`
    ///
    /// - Returns: Dictionary mapping each role to its encode handler
    public static func defaultRegistry() -> [Role: EncodeHandler] {
        [
            .developer: { message, encoder in
                try encodeDeveloperMessage(message, encoder: encoder)
            },
            .system: { message, encoder in
                try encodeSystemMessage(message, encoder: encoder)
            },
            .user: { message, encoder in
                try encodeUserMessage(message, encoder: encoder)
            },
            .assistant: { message, encoder in
                try encodeAssistantMessage(message, encoder: encoder)
            },
            .tool: { message, encoder in
                try encodeToolMessage(message, encoder: encoder)
            },
            .activity: { message, encoder in
                try encodeActivityMessage(message, encoder: encoder)
            },
            .reasoning: { message, encoder in
                try encodeReasoningMessage(message, encoder: encoder)
            }
        ]
    }
}

// MARK: - Message Encoding Error

/// Errors that can occur during message encoding.
public enum MessageEncodingError: Error, Sendable {
    /// The message role has no registered encode handler.
    ///
    /// - Parameter role: The unsupported role
    case unsupportedRole(Role)

    /// The message type doesn't match its declared role.
    ///
    /// For example, a message with role `.user` that isn't actually a `UserMessage`.
    ///
    /// - Parameters:
    ///   - role: The expected role
    ///   - actualType: The actual type name
    case invalidMessageType(Role, String)

    /// Encoding failed due to an error in the message data.
    ///
    /// - Parameter message: Description of the encoding failure
    case encodingFailed(String)
}

extension MessageEncodingError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unsupportedRole(let role):
            return "Unsupported message role: \(role.rawValue)"
        case .invalidMessageType(let role, let actualType):
            return "Message role is \(role.rawValue) but type is \(actualType)"
        case .encodingFailed(let message):
            return "Message encoding failed: \(message)"
        }
    }
}

// MARK: - Message Encoding Functions

/// Encodes a DeveloperMessage to JSON data.
private func encodeDeveloperMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let devMsg = message as? DeveloperMessage else {
        throw MessageEncodingError.invalidMessageType(.developer, String(describing: type(of: message)))
    }

    var dict: [String: Any] = [
        "id": devMsg.id,
        "role": devMsg.role.rawValue,
        "content": devMsg.content ?? ""
    ]
    if let name = devMsg.name {
        dict["name"] = name
    }
    if let encryptedValue = devMsg.encryptedValue {
        dict["encryptedValue"] = encryptedValue
    }
    return try JSONSerialization.data(withJSONObject: dict)
}

/// Encodes a SystemMessage to JSON data.
private func encodeSystemMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let sysMsg = message as? SystemMessage else {
        throw MessageEncodingError.invalidMessageType(.system, String(describing: type(of: message)))
    }

    var dict: [String: Any] = [
        "id": sysMsg.id,
        "role": sysMsg.role.rawValue,
        "content": sysMsg.content
    ]
    if let name = sysMsg.name {
        dict["name"] = name
    }
    if let encryptedValue = sysMsg.encryptedValue {
        dict["encryptedValue"] = encryptedValue
    }
    return try JSONSerialization.data(withJSONObject: dict)
}

/// Encodes a UserMessage to JSON data.
private func encodeUserMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let userMsg = message as? UserMessage else {
        throw MessageEncodingError.invalidMessageType(.user, String(describing: type(of: message)))
    }

    var dict: [String: Any] = [
        "id": userMsg.id,
        "role": userMsg.role.rawValue
    ]

    // Handle polymorphic content
    if let parts = userMsg.contentParts {
        // Multimodal - encode as array
        var contentArray: [[String: Any]] = []
        for part in parts {
            if let textPart = part as? TextInputContent {
                contentArray.append([
                    "type": "text",
                    "text": textPart.text
                ])
            } else if let binaryPart = part as? BinaryInputContent {
                var binaryDict: [String: Any] = [
                    "type": "binary",
                    "mimeType": binaryPart.mimeType
                ]
                if let id = binaryPart.id {
                    binaryDict["id"] = id
                }
                if let url = binaryPart.url {
                    binaryDict["url"] = url
                }
                if let data = binaryPart.data {
                    binaryDict["data"] = data
                }
                if let filename = binaryPart.filename {
                    binaryDict["filename"] = filename
                }
                contentArray.append(binaryDict)
            } else if let imagePart = part as? ImageInputContent {
                var d: [String: Any] = ["type": "image"]
                if let url = imagePart.url { d["url"] = url }
                if let data = imagePart.data { d["data"] = data }
                if let detail = imagePart.detail { d["detail"] = detail }
                if let mimeType = imagePart.mimeType { d["mimeType"] = mimeType }
                contentArray.append(d)
            } else if let audioPart = part as? AudioInputContent {
                var d: [String: Any] = ["type": "audio"]
                if let url = audioPart.url { d["url"] = url }
                if let data = audioPart.data { d["data"] = data }
                if let format = audioPart.format { d["format"] = format }
                if let mimeType = audioPart.mimeType { d["mimeType"] = mimeType }
                contentArray.append(d)
            } else if let videoPart = part as? VideoInputContent {
                var d: [String: Any] = ["type": "video"]
                if let url = videoPart.url { d["url"] = url }
                if let data = videoPart.data { d["data"] = data }
                if let mimeType = videoPart.mimeType { d["mimeType"] = mimeType }
                contentArray.append(d)
            } else if let docPart = part as? DocumentInputContent {
                var d: [String: Any] = ["type": "document"]
                if let url = docPart.url { d["url"] = url }
                if let data = docPart.data { d["data"] = data }
                if let mimeType = docPart.mimeType { d["mimeType"] = mimeType }
                if let title = docPart.title { d["title"] = title }
                contentArray.append(d)
            }
        }
        dict["content"] = contentArray
    } else {
        // Text-only
        dict["content"] = userMsg.content ?? ""
    }

    if let name = userMsg.name {
        dict["name"] = name
    }
    if let encryptedValue = userMsg.encryptedValue {
        dict["encryptedValue"] = encryptedValue
    }
    return try JSONSerialization.data(withJSONObject: dict)
}

/// Encodes an AssistantMessage to JSON data.
private func encodeAssistantMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let assistantMsg = message as? AssistantMessage else {
        throw MessageEncodingError.invalidMessageType(.assistant, String(describing: type(of: message)))
    }

    var dict: [String: Any] = [
        "id": assistantMsg.id,
        "role": assistantMsg.role.rawValue
    ]
    if let content = assistantMsg.content {
        dict["content"] = content
    }
    if let name = assistantMsg.name {
        dict["name"] = name
    }
    if let toolCalls = assistantMsg.toolCalls {
        let toolCallsData = try encoder.encode(toolCalls)
        let toolCallsArray = try JSONSerialization.jsonObject(with: toolCallsData)
        dict["toolCalls"] = toolCallsArray
    }
    if let encryptedValue = assistantMsg.encryptedValue {
        dict["encryptedValue"] = encryptedValue
    }
    return try JSONSerialization.data(withJSONObject: dict)
}

/// Encodes a ToolMessage to JSON data.
private func encodeToolMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let toolMsg = message as? ToolMessage else {
        throw MessageEncodingError.invalidMessageType(.tool, String(describing: type(of: message)))
    }

    var dict: [String: Any] = [
        "id": toolMsg.id,
        "role": toolMsg.role.rawValue,
        "toolCallId": toolMsg.toolCallId,
        "content": toolMsg.content
    ]
    if let name = toolMsg.name {
        dict["name"] = name
    }
    if let error = toolMsg.error {
        dict["error"] = error
    }
    if let encryptedValue = toolMsg.encryptedValue {
        dict["encryptedValue"] = encryptedValue
    }
    return try JSONSerialization.data(withJSONObject: dict)
}

/// Encodes an ActivityMessage to JSON data.
private func encodeActivityMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let activityMsg = message as? ActivityMessage else {
        throw MessageEncodingError.invalidMessageType(.activity, String(describing: type(of: message)))
    }

    let activityContentObj = try JSONSerialization.jsonObject(with: activityMsg.content)
    let dict: [String: Any] = [
        "id": activityMsg.id,
        "role": activityMsg.role.rawValue,
        "activityType": activityMsg.activityType,
        "content": activityContentObj
    ]
    return try JSONSerialization.data(withJSONObject: dict)
}

/// Encodes a ReasoningMessage to JSON data.
private func encodeReasoningMessage(_ message: any Message, encoder: JSONEncoder) throws -> Data {
    guard let reasoningMsg = message as? ReasoningMessage else {
        throw MessageEncodingError.invalidMessageType(.reasoning, String(describing: type(of: message)))
    }

    var dict: [String: Any] = [
        "id": reasoningMsg.id,
        "role": reasoningMsg.role.rawValue
    ]
    if let content = reasoningMsg.content {
        dict["content"] = content
    }
    if let encryptedValue = reasoningMsg.encryptedValue {
        dict["encryptedValue"] = encryptedValue
    }
    return try JSONSerialization.data(withJSONObject: dict)
}
