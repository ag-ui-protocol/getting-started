// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Records the caller's response to a single human-in-the-loop interrupt.
///
/// When an agent run finishes with `RunFinishedOutcome.interrupt`, the caller
/// resolves or cancels each interrupt and then restarts the run by including a
/// `resume` array in the next `RunAgentInput`.
///
/// ```swift
/// let resumeEntry = ResumeEntry(
///     interruptId: "int-1",
///     status: .resolved,
///     payload: Data(#"{"approved": true}"#.utf8)
/// )
///
/// let input = RunAgentInput.builder()
///     .threadId(threadId)
///     .runId(UUID().uuidString)
///     .resume([resumeEntry])
///     .build()
/// ```
///
/// - SeeAlso: `Interrupt`, `RunFinishedOutcome`, `RunAgentInput`
public struct ResumeEntry: Sendable, Equatable, Hashable {

    /// The `id` of the `Interrupt` this entry responds to.
    public let interruptId: String

    /// Whether the interrupt was resolved or cancelled.
    public let status: ResumeStatus

    /// Arbitrary JSON payload supplied by the caller in response to the interrupt.
    ///
    /// Corresponds to `payload: z.any().optional()` in the TypeScript spec.
    /// Stored as raw JSON `Data` because the payload structure is defined by the
    /// agent's `responseSchema`.
    public let payload: Data?

    /// Creates a new `ResumeEntry`.
    public init(interruptId: String, status: ResumeStatus, payload: Data? = nil) {
        self.interruptId = interruptId
        self.status = status
        self.payload = payload
    }

    /// The resolution status of an interrupt.
    public enum ResumeStatus: String, Sendable, Equatable, Hashable, Codable {
        case resolved
        case cancelled
    }
}

// MARK: - Codable

extension ResumeEntry: Codable {

    private enum CodingKeys: String, CodingKey {
        case interruptId, status, payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        interruptId = try container.decode(String.self, forKey: .interruptId)
        status = try container.decode(ResumeStatus.self, forKey: .status)

        // payload is z.any() — it can be any JSON value: object, array, string,
        // number, or boolean. We preserve it as raw JSON Data.
        if container.contains(.payload), !(try container.decodeNil(forKey: .payload)) {
            payload = try Self.decodeAnyPayload(from: container, forKey: .payload)
        } else {
            payload = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(interruptId, forKey: .interruptId)
        try container.encode(status, forKey: .status)

        if let payload {
            try Self.encodeAnyPayload(payload, into: &container, forKey: .payload)
        }
        // When payload is nil, omit the key entirely (encodeIfPresent semantics)
    }

    // MARK: - Any-JSON payload helpers

    /// Decodes a JSON value of any type into raw `Data`.
    ///
    /// Scalar values (bool, number, string) are serialized directly to their JSON byte
    /// representations (`true`, `false`, `42`, `"hello"`) rather than through
    /// `JSONSerialization.data(withJSONObject:)`, which only accepts top-level
    /// containers (dict or array) on all supported platform versions.
    private static func decodeAnyPayload(
        from container: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws -> Data? {
        // Try object
        if let objectContainer = try? container.nestedContainer(keyedBy: JSONCodingKeys.self, forKey: key) {
            let object = try objectContainer.decodeJSONObject()
            return try JSONSerialization.data(withJSONObject: object)
        }
        // Try array
        if var arrayContainer = try? container.nestedUnkeyedContainer(forKey: key) {
            let array = try arrayContainer.decodeJSONArray()
            return try JSONSerialization.data(withJSONObject: array)
        }
        // Decode scalar types — Bool before Int/Double to avoid NSNumber ambiguity.
        // Use raw JSON bytes; JSONSerialization.data() does not accept scalars as top-level values.
        if let value = try? container.decode(Bool.self, forKey: key) {
            return Data(value ? "true".utf8 : "false".utf8)
        }
        if let value = try? container.decode(Int.self, forKey: key) {
            return Data("\(value)".utf8)
        }
        if let value = try? container.decode(Double.self, forKey: key) {
            return Data("\(value)".utf8)
        }
        if let value = try? container.decode(String.self, forKey: key) {
            // Produce a properly JSON-escaped quoted string via array wrapper.
            let wrapped = try JSONSerialization.data(withJSONObject: [value])
            if let json = String(data: wrapped, encoding: .utf8),
               json.hasPrefix("[") && json.hasSuffix("]") {
                return Data(json.dropFirst().dropLast().utf8)
            }
            return Data("\"\(value)\"".utf8)
        }
        return nil
    }

    /// Encodes the `Data` payload back as the correct JSON value type.
    private static func encodeAnyPayload(
        _ payload: Data,
        into container: inout KeyedEncodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) throws {
        let value = try JSONSerialization.jsonObject(with: payload, options: .fragmentsAllowed)

        if let dict = value as? [String: Any] {
            var nested = container.nestedContainer(keyedBy: JSONCodingKeys.self, forKey: key)
            try nested.encodeJSONObject(dict)
        } else if let array = value as? [Any] {
            var nested = container.nestedUnkeyedContainer(forKey: key)
            try nested.encodeJSONArray(array)
        } else if let bool = value as? Bool {
            try container.encode(bool, forKey: key)
        } else if let int = value as? Int {
            try container.encode(int, forKey: key)
        } else if let double = value as? Double {
            try container.encode(double, forKey: key)
        } else if let string = value as? String {
            try container.encode(string, forKey: key)
        } else {
            try container.encodeNil(forKey: key)
        }
    }
}
