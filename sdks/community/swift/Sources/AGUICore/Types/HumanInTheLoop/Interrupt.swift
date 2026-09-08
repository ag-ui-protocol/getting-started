// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Describes a single human-in-the-loop interrupt emitted by an agent.
///
/// When an agent run finishes with `RunFinishedOutcome.interrupt`, it carries one or
/// more `Interrupt` values that describe what the agent is waiting for and how the
/// caller should respond.
///
/// On the wire this appears inside the `RunFinishedEvent.outcome` object:
/// ```json
/// {
///   "type": "interrupt",
///   "interrupts": [
///     {
///       "id": "interrupt-uuid",
///       "reason": "Approval required",
///       "toolCallId": "tool-call-abc",
///       "responseSchema": { "approved": { "type": "boolean" } }
///     }
///   ]
/// }
/// ```
///
/// The caller resumes the run by sending a new `RunAgentInput` with a `resume` array
/// containing a `ResumeEntry` that references this interrupt's `id`.
///
/// - SeeAlso: `RunFinishedOutcome`, `ResumeEntry`, `RunAgentInput`
public struct Interrupt: Sendable, Equatable, Hashable {

    /// Unique identifier for this interrupt.
    public let id: String

    /// Human-readable description of why the agent interrupted.
    public let reason: String

    /// Optional message for the user.
    public let message: String?

    /// ID of the tool call that triggered this interrupt, if applicable.
    public let toolCallId: String?

    /// JSON Schema describing the expected response payload.
    ///
    /// Corresponds to `responseSchema: z.record(z.any()).optional()` in the TypeScript spec.
    /// Stored as raw JSON `Data` because the schema structure is arbitrary.
    public let responseSchema: Data?

    /// Optional expiry timestamp (ISO-8601 string) after which this interrupt is no longer valid.
    public let expiresAt: String?

    /// Arbitrary tool metadata as raw JSON.
    ///
    /// Corresponds to `metadata: z.record(z.any()).optional()` in the TypeScript spec.
    public let metadata: Data?

    /// Creates a new `Interrupt`.
    public init(
        id: String,
        reason: String,
        message: String? = nil,
        toolCallId: String? = nil,
        responseSchema: Data? = nil,
        expiresAt: String? = nil,
        metadata: Data? = nil
    ) {
        self.id = id
        self.reason = reason
        self.message = message
        self.toolCallId = toolCallId
        self.responseSchema = responseSchema
        self.expiresAt = expiresAt
        self.metadata = metadata
    }
}

// MARK: - Decoding

extension Interrupt {

    /// Decodes an `Interrupt` from a raw JSON dictionary extracted via `JSONSerialization`.
    ///
    /// - Parameter dict: A `[String: Any]` dictionary for a single interrupt object.
    /// - Throws: `DecodingError` when required fields are missing or have the wrong type.
    static func decode(from dict: [String: Any]) throws -> Interrupt {
        guard let id = dict["id"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.id,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: id")
            )
        }
        guard let reason = dict["reason"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.reason,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: reason")
            )
        }

        let message = dict["message"] as? String
        let toolCallId = dict["toolCallId"] as? String
        let expiresAt = dict["expiresAt"] as? String

        var responseSchema: Data?
        if let raw = dict["responseSchema"], !(raw is NSNull) {
            responseSchema = try? JSONSerialization.data(withJSONObject: raw)
        }

        var metadata: Data?
        if let raw = dict["metadata"], !(raw is NSNull) {
            metadata = try? JSONSerialization.data(withJSONObject: raw)
        }

        return Interrupt(
            id: id,
            reason: reason,
            message: message,
            toolCallId: toolCallId,
            responseSchema: responseSchema,
            expiresAt: expiresAt,
            metadata: metadata
        )
    }
}

// MARK: - Codable

extension Interrupt: Codable {

    private enum CodingKeys: String, CodingKey {
        case id, reason, message, toolCallId, responseSchema, expiresAt, metadata
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        reason = try container.decode(String.self, forKey: .reason)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        toolCallId = try container.decodeIfPresent(String.self, forKey: .toolCallId)
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)

        // Decode arbitrary JSON objects → Data
        if container.contains(.responseSchema),
           !(try container.decodeNil(forKey: .responseSchema)) {
            let schemaContainer = try container.nestedContainer(
                keyedBy: JSONCodingKeys.self, forKey: .responseSchema
            )
            let schemaObject = try schemaContainer.decodeJSONObject()
            responseSchema = try JSONSerialization.data(withJSONObject: schemaObject)
        } else {
            responseSchema = nil
        }

        if container.contains(.metadata),
           !(try container.decodeNil(forKey: .metadata)) {
            let metaContainer = try container.nestedContainer(
                keyedBy: JSONCodingKeys.self, forKey: .metadata
            )
            let metaObject = try metaContainer.decodeJSONObject()
            metadata = try JSONSerialization.data(withJSONObject: metaObject)
        } else {
            metadata = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(reason, forKey: .reason)
        try container.encodeIfPresent(message, forKey: .message)
        try container.encodeIfPresent(toolCallId, forKey: .toolCallId)
        try container.encodeIfPresent(expiresAt, forKey: .expiresAt)

        if let responseSchema {
            let schemaObject = try JSONSerialization.jsonObject(with: responseSchema)
            var schemaContainer = container.nestedContainer(
                keyedBy: JSONCodingKeys.self, forKey: .responseSchema
            )
            try schemaContainer.encodeJSONObject(schemaObject)
        }

        if let metadata {
            let metaObject = try JSONSerialization.jsonObject(with: metadata)
            var metaContainer = container.nestedContainer(
                keyedBy: JSONCodingKeys.self, forKey: .metadata
            )
            try metaContainer.encodeJSONObject(metaObject)
        }
    }
}
