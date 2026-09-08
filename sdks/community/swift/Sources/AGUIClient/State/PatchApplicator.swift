// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Applies RFC 6902 JSON Patch operations to JSON documents.
///
/// PatchApplicator implements the JSON Patch specification (RFC 6902) for
/// applying incremental changes to JSON documents. It supports all standard
/// operations: add, remove, replace, move, copy, and test.
///
/// ## Usage
///
/// ```swift
/// let applicator = PatchApplicator()
///
/// let state = Data("{\"count\":5}".utf8)
/// let patch = Data("""
/// [{"op":"replace","path":"/count","value":10}]
/// """.utf8)
///
/// let newState = try applicator.apply(patch: patch, to: state)
/// ```
///
/// ## Supported Operations
///
/// - `add`: Adds a value to an object or inserts into an array
/// - `remove`: Removes a value from an object or array
/// - `replace`: Replaces a value
/// - `move`: Moves a value from one location to another
/// - `copy`: Copies a value from one location to another
/// - `test`: Tests that a value equals the specified value
///
/// ## Path Format (RFC 6901)
///
/// Paths use JSON Pointer format:
/// - `/foo` - Root-level field "foo"
/// - `/foo/bar` - Nested field "bar" in object "foo"
/// - `/items/0` - First element of array "items"
/// - `/items/-` - Append to array "items"
/// - `/a~0b` - Field "a~b" (~ encoded as ~0)
/// - `/a~1b` - Field "a/b" (/ encoded as ~1)
///
/// - SeeAlso: [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
/// - SeeAlso: [RFC 6901 - JSON Pointer](https://tools.ietf.org/html/rfc6901)
public struct PatchApplicator: Sendable {
    /// Errors that can occur during patch application.
    public enum PatchError: Error, LocalizedError {
        case invalidJSON(String)
        case invalidPatch(String)
        case invalidOperation(String)
        case pathNotFound(String)
        case testFailed(String)

        public var errorDescription: String? {
            switch self {
            case .invalidJSON(let message):
                return "Invalid JSON: \(message)"
            case .invalidPatch(let message):
                return "Invalid patch: \(message)"
            case .invalidOperation(let message):
                return "Invalid operation: \(message)"
            case .pathNotFound(let path):
                return "Path not found: \(path)"
            case .testFailed(let message):
                return "Test operation failed: \(message)"
            }
        }
    }

    /// Patch operation decoded from JSON.
    private struct PatchOperation: Decodable {
        let op: String
        let path: String
        let value: AnyCodable?
        let from: String?

        enum CodingKeys: String, CodingKey {
            case op, path, value, from
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            op = try container.decode(String.self, forKey: .op)
            path = try container.decode(String.self, forKey: .path)

            // Use contains check to distinguish between missing field (nil) and explicit null (NSNull)
            if container.contains(.value) {
                value = try container.decode(AnyCodable.self, forKey: .value)
            } else {
                value = nil
            }

            from = try container.decodeIfPresent(String.self, forKey: .from)
        }
    }

    public init() {}

    /// Applies JSON Patch operations to a JSON document.
    ///
    /// - Parameters:
    ///   - patch: JSON Patch document (array of operations)
    ///   - state: Current JSON document
    /// - Returns: Updated JSON document
    /// - Throws: `PatchError` if patch is invalid or cannot be applied
    public func apply(patch: Data, to state: Data) throws -> Data {
        // Parse state JSON
        guard let stateObject = try? JSONSerialization.jsonObject(with: state) else {
            throw PatchError.invalidJSON("Unable to parse state JSON")
        }

        // Parse patch operations
        let operations: [PatchOperation]
        do {
            operations = try JSONDecoder().decode([PatchOperation].self, from: patch)
        } catch {
            throw PatchError.invalidPatch("Unable to parse patch JSON: \(error.localizedDescription)")
        }

        // Apply operations sequentially
        var mutableState = stateObject

        for operation in operations {
            mutableState = try applyOperation(operation, to: mutableState)
        }

        // Serialize back to JSON
        do {
            return try JSONSerialization.data(withJSONObject: mutableState)
        } catch {
            throw PatchError.invalidJSON("Unable to serialize result: \(error.localizedDescription)")
        }
    }

    // MARK: - Operation Application

    private func applyOperation(_ operation: PatchOperation, to state: Any) throws -> Any {
        switch operation.op {
        case "add":
            guard let wrapper = operation.value else {
                throw PatchError.invalidOperation("add operation missing value")
            }
            return try applyAdd(path: operation.path, value: wrapper.value, to: state)

        case "remove":
            return try applyRemove(path: operation.path, from: state)

        case "replace":
            guard let wrapper = operation.value else {
                throw PatchError.invalidOperation("replace operation missing value")
            }
            return try applyReplace(path: operation.path, value: wrapper.value, to: state)

        case "move":
            guard let from = operation.from else {
                throw PatchError.invalidOperation("move operation missing from")
            }
            return try applyMove(from: from, to: operation.path, in: state)

        case "copy":
            guard let from = operation.from else {
                throw PatchError.invalidOperation("copy operation missing from")
            }
            return try applyCopy(from: from, to: operation.path, in: state)

        case "test":
            guard let wrapper = operation.value else {
                throw PatchError.invalidOperation("test operation missing value")
            }
            return try applyTest(path: operation.path, value: wrapper.value, to: state)

        default:
            throw PatchError.invalidOperation("Unknown operation: \(operation.op)")
        }
    }

    // MARK: - Individual Operations

    private func applyAdd(path: String, value: Any, to state: Any) throws -> Any {
        let tokens = try parsePath(path)

        // Special case: root path replacement
        if tokens.isEmpty {
            return value
        }

        var current = state
        let lastToken = tokens.last!
        let parentTokens = tokens.dropLast()

        // Navigate to parent
        if !parentTokens.isEmpty {
            current = try navigate(to: Array(parentTokens), in: current)
        }

        // Add to parent
        if var dict = current as? [String: Any] {
            dict[lastToken] = value
            return try updateParent(state, at: Array(parentTokens), with: dict)
        } else if var array = current as? [Any] {
            if lastToken == "-" {
                array.append(value)
            } else if let index = Int(lastToken) {
                guard index >= 0 && index <= array.count else {
                    throw PatchError.pathNotFound("Array index out of bounds: \(index)")
                }
                array.insert(value, at: index)
            } else {
                throw PatchError.invalidOperation("Invalid array index: \(lastToken)")
            }
            return try updateParent(state, at: Array(parentTokens), with: array)
        } else {
            throw PatchError.invalidOperation("Cannot add to non-object/non-array")
        }
    }

    private func applyRemove(path: String, from state: Any) throws -> Any {
        let tokens = try parsePath(path)
        guard !tokens.isEmpty else {
            throw PatchError.invalidOperation("Cannot remove root")
        }

        var current = state
        let lastToken = tokens.last!
        let parentTokens = tokens.dropLast()

        // Navigate to parent
        if !parentTokens.isEmpty {
            current = try navigate(to: Array(parentTokens), in: current)
        }

        // Remove from parent
        if var dict = current as? [String: Any] {
            guard dict[lastToken] != nil else {
                throw PatchError.pathNotFound(path)
            }
            dict.removeValue(forKey: lastToken)
            return try updateParent(state, at: Array(parentTokens), with: dict)
        } else if var array = current as? [Any] {
            guard let index = Int(lastToken), index >= 0 && index < array.count else {
                throw PatchError.pathNotFound(path)
            }
            array.remove(at: index)
            return try updateParent(state, at: Array(parentTokens), with: array)
        } else {
            throw PatchError.invalidOperation("Cannot remove from non-object/non-array")
        }
    }

    private func applyReplace(path: String, value: Any, to state: Any) throws -> Any {
        let tokens = try parsePath(path)
        guard !tokens.isEmpty else {
            return value  // Replace root
        }

        var current = state
        let lastToken = tokens.last!
        let parentTokens = tokens.dropLast()

        // Navigate to parent
        if !parentTokens.isEmpty {
            current = try navigate(to: Array(parentTokens), in: current)
        }

        // Replace in parent
        if var dict = current as? [String: Any] {
            guard dict[lastToken] != nil else {
                throw PatchError.pathNotFound(path)
            }
            dict[lastToken] = value
            return try updateParent(state, at: Array(parentTokens), with: dict)
        } else if var array = current as? [Any] {
            guard let index = Int(lastToken), index >= 0 && index < array.count else {
                throw PatchError.pathNotFound(path)
            }
            array[index] = value
            return try updateParent(state, at: Array(parentTokens), with: array)
        } else {
            throw PatchError.invalidOperation("Cannot replace in non-object/non-array")
        }
    }

    private func applyMove(from: String, to: String, in state: Any) throws -> Any {
        // Get value at 'from' path
        let value = try getValue(at: from, in: state)

        // Remove from 'from' path
        var intermediate = try applyRemove(path: from, from: state)

        // Add to 'to' path
        return try applyAdd(path: to, value: value, to: intermediate)
    }

    private func applyCopy(from: String, to: String, in state: Any) throws -> Any {
        // Get value at 'from' path
        let value = try getValue(at: from, in: state)

        // Add to 'to' path
        return try applyAdd(path: to, value: value, to: state)
    }

    private func applyTest(path: String, value: Any, to state: Any) throws -> Any {
        let actualValue = try getValue(at: path, in: state)

        // Compare values
        guard areEqual(actualValue, value) else {
            throw PatchError.testFailed("Value at \(path) does not match expected value")
        }

        return state  // Test doesn't modify state
    }

    // MARK: - Helper Methods

    private func parsePath(_ path: String) throws -> [String] {
        guard path.hasPrefix("/") else {
            throw PatchError.invalidOperation("Path must start with /: \(path)")
        }

        // Per RFC 6901: "/" means the empty-string key "". Root is represented by "".
        if path == "/" {
            return [""]
        }

        return path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map { token in
            let decoded = String(token)
                .replacingOccurrences(of: "~1", with: "/")
                .replacingOccurrences(of: "~0", with: "~")
            return decoded
        }
    }

    private func navigate(to tokens: [String], in state: Any) throws -> Any {
        var current = state

        for token in tokens {
            if let dict = current as? [String: Any] {
                guard let next = dict[token] else {
                    throw PatchError.pathNotFound("/\(tokens.joined(separator: "/"))")
                }
                current = next
            } else if let array = current as? [Any] {
                guard let index = Int(token), index >= 0 && index < array.count else {
                    throw PatchError.pathNotFound("/\(tokens.joined(separator: "/"))")
                }
                current = array[index]
            } else {
                throw PatchError.pathNotFound("/\(tokens.joined(separator: "/"))")
            }
        }

        return current
    }

    private func getValue(at path: String, in state: Any) throws -> Any {
        let tokens = try parsePath(path)

        if tokens.isEmpty {
            return state
        }

        return try navigate(to: tokens, in: state)
    }

    private func updateParent(_ state: Any, at tokens: [String], with value: Any) throws -> Any {
        if tokens.isEmpty {
            return value
        }

        var current = state
        var components: [(Any, String)] = []

        // Navigate and collect components
        for token in tokens {
            components.append((current, token))

            if let dict = current as? [String: Any] {
                guard let next = dict[token] else {
                    throw PatchError.pathNotFound("/\(tokens.joined(separator: "/"))")
                }
                current = next
            } else if let array = current as? [Any] {
                guard let index = Int(token), index >= 0 && index < array.count else {
                    throw PatchError.pathNotFound("/\(tokens.joined(separator: "/"))")
                }
                current = array[index]
            }
        }

        // Rebuild from bottom up
        var updated = value

        for (parent, token) in components.reversed() {
            if var dict = parent as? [String: Any] {
                dict[token] = updated
                updated = dict
            } else if var array = parent as? [Any] {
                guard let index = Int(token), index >= 0 && index < array.count else {
                    throw PatchError.pathNotFound("/\(tokens.joined(separator: "/"))")
                }
                array[index] = updated
                updated = array
            }
        }

        return updated
    }

    private func areEqual(_ lhs: Any, _ rhs: Any) -> Bool {
        // Handle NSNull
        if lhs is NSNull && rhs is NSNull {
            return true
        }

        // Compare dictionaries
        if let lhsDict = lhs as? [String: Any], let rhsDict = rhs as? [String: Any] {
            guard lhsDict.count == rhsDict.count else { return false }
            for (key, value) in lhsDict {
                guard let rhsValue = rhsDict[key], areEqual(value, rhsValue) else {
                    return false
                }
            }
            return true
        }

        // Compare arrays
        if let lhsArray = lhs as? [Any], let rhsArray = rhs as? [Any] {
            guard lhsArray.count == rhsArray.count else { return false }
            for (lhsElement, rhsElement) in zip(lhsArray, rhsArray) {
                guard areEqual(lhsElement, rhsElement) else {
                    return false
                }
            }
            return true
        }

        // Compare primitives using NSObject comparison
        if let lhsObj = lhs as? NSObject, let rhsObj = rhs as? NSObject {
            return lhsObj == rhsObj
        }

        return false
    }
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for decoding arbitrary JSON values.
private struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unable to decode value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        if value is NSNull {
            try container.encodeNil()
        } else if let bool = value as? Bool {
            try container.encode(bool)
        } else if let int = value as? Int {
            try container.encode(int)
        } else if let double = value as? Double {
            try container.encode(double)
        } else if let string = value as? String {
            try container.encode(string)
        } else if let array = value as? [Any] {
            try container.encode(array.map { AnyCodable($0) })
        } else if let dict = value as? [String: Any] {
            try container.encode(dict.mapValues { AnyCodable($0) })
        } else {
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(codingPath: container.codingPath, debugDescription: "Unable to encode value")
            )
        }
    }
}
