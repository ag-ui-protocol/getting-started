// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class InterruptTests: XCTestCase {

    // MARK: - Initialization

    func test_init_withRequiredFields_storesValues() {
        let interrupt = Interrupt(id: "int-1", reason: "Approval required")

        XCTAssertEqual(interrupt.id, "int-1")
        XCTAssertEqual(interrupt.reason, "Approval required")
        XCTAssertNil(interrupt.message)
        XCTAssertNil(interrupt.toolCallId)
        XCTAssertNil(interrupt.responseSchema)
        XCTAssertNil(interrupt.expiresAt)
        XCTAssertNil(interrupt.metadata)
    }

    func test_init_withAllFields_storesValues() {
        let schema = Data(#"{"approved":{"type":"boolean"}}"#.utf8)
        let meta = Data(#"{"source":"tool-executor"}"#.utf8)

        let interrupt = Interrupt(
            id: "int-2",
            reason: "Confirmation needed",
            message: "Please confirm the action",
            toolCallId: "tool-call-abc",
            responseSchema: schema,
            expiresAt: "2025-12-31T23:59:59Z",
            metadata: meta
        )

        XCTAssertEqual(interrupt.id, "int-2")
        XCTAssertEqual(interrupt.reason, "Confirmation needed")
        XCTAssertEqual(interrupt.message, "Please confirm the action")
        XCTAssertEqual(interrupt.toolCallId, "tool-call-abc")
        XCTAssertEqual(interrupt.responseSchema, schema)
        XCTAssertEqual(interrupt.expiresAt, "2025-12-31T23:59:59Z")
        XCTAssertEqual(interrupt.metadata, meta)
    }

    // MARK: - Codable round-trip

    func test_codable_roundTrip_withRequiredFieldsOnly() throws {
        let original = Interrupt(id: "int-1", reason: "Needs review")
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Interrupt.self, from: encoded)

        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.reason, original.reason)
        XCTAssertNil(decoded.message)
        XCTAssertNil(decoded.toolCallId)
        XCTAssertNil(decoded.responseSchema)
        XCTAssertNil(decoded.expiresAt)
        XCTAssertNil(decoded.metadata)
    }

    func test_codable_roundTrip_withAllFields() throws {
        let schema = Data(#"{"type":"object","properties":{"value":{"type":"string"}}}"#.utf8)
        let meta = Data(#"{"priority":"high"}"#.utf8)

        let original = Interrupt(
            id: "int-full",
            reason: "Full interrupt",
            message: "User action needed",
            toolCallId: "tool-xyz",
            responseSchema: schema,
            expiresAt: "2025-06-30T00:00:00Z",
            metadata: meta
        )

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Interrupt.self, from: encoded)

        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.reason, original.reason)
        XCTAssertEqual(decoded.message, original.message)
        XCTAssertEqual(decoded.toolCallId, original.toolCallId)
        XCTAssertEqual(decoded.expiresAt, original.expiresAt)

        // Verify responseSchema survives the round-trip as equivalent JSON
        let originalSchema = try JSONSerialization.jsonObject(with: schema) as? [String: Any]
        let decodedSchema = try XCTUnwrap(decoded.responseSchema)
        let roundTrippedSchema = try JSONSerialization.jsonObject(with: decodedSchema) as? [String: Any]
        XCTAssertEqual(originalSchema?.keys.sorted(), roundTrippedSchema?.keys.sorted())

        // Verify metadata survives the round-trip as equivalent JSON
        let originalMeta = try JSONSerialization.jsonObject(with: meta) as? [String: Any]
        let decodedMeta = try XCTUnwrap(decoded.metadata)
        let roundTrippedMeta = try JSONSerialization.jsonObject(with: decodedMeta) as? [String: Any]
        XCTAssertEqual(originalMeta?.keys.sorted(), roundTrippedMeta?.keys.sorted())
    }

    func test_codable_omitsNilFields_fromJSON() throws {
        let interrupt = Interrupt(id: "int-1", reason: "Simple")
        let encoded = try JSONEncoder().encode(interrupt)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        XCTAssertNotNil(json["id"])
        XCTAssertNotNil(json["reason"])
        XCTAssertNil(json["message"])
        XCTAssertNil(json["toolCallId"])
        XCTAssertNil(json["responseSchema"])
        XCTAssertNil(json["expiresAt"])
        XCTAssertNil(json["metadata"])
    }

    // MARK: - Manual decode (from [String: Any])

    func test_decode_fromDict_withRequiredFields_succeeds() throws {
        let dict: [String: Any] = ["id": "int-1", "reason": "Check needed"]
        let interrupt = try Interrupt.decode(from: dict)

        XCTAssertEqual(interrupt.id, "int-1")
        XCTAssertEqual(interrupt.reason, "Check needed")
        XCTAssertNil(interrupt.message)
        XCTAssertNil(interrupt.toolCallId)
    }

    func test_decode_fromDict_withAllFields_succeeds() throws {
        let dict: [String: Any] = [
            "id": "int-full",
            "reason": "Tool approval",
            "message": "Approve the database write",
            "toolCallId": "tc-123",
            "responseSchema": ["approved": ["type": "boolean"]],
            "expiresAt": "2025-12-01T00:00:00Z",
            "metadata": ["source": "executor"]
        ]
        let interrupt = try Interrupt.decode(from: dict)

        XCTAssertEqual(interrupt.id, "int-full")
        XCTAssertEqual(interrupt.reason, "Tool approval")
        XCTAssertEqual(interrupt.message, "Approve the database write")
        XCTAssertEqual(interrupt.toolCallId, "tc-123")
        XCTAssertNotNil(interrupt.responseSchema)
        XCTAssertEqual(interrupt.expiresAt, "2025-12-01T00:00:00Z")
        XCTAssertNotNil(interrupt.metadata)
    }

    func test_decode_fromDict_missingId_throws() {
        let dict: [String: Any] = ["reason": "Missing id"]
        XCTAssertThrowsError(try Interrupt.decode(from: dict))
    }

    func test_decode_fromDict_missingReason_throws() {
        let dict: [String: Any] = ["id": "int-1"]
        XCTAssertThrowsError(try Interrupt.decode(from: dict))
    }

    func test_decode_fromDict_nullResponseSchema_yieldsNil() throws {
        let dict: [String: Any] = ["id": "int-1", "reason": "R", "responseSchema": NSNull()]
        let interrupt = try Interrupt.decode(from: dict)
        XCTAssertNil(interrupt.responseSchema)
    }

    // MARK: - Equatable

    func test_equatable_sameValues_areEqual() {
        let a = Interrupt(id: "int-1", reason: "R")
        let b = Interrupt(id: "int-1", reason: "R")
        XCTAssertEqual(a, b)
    }

    func test_equatable_differentId_notEqual() {
        let a = Interrupt(id: "int-1", reason: "R")
        let b = Interrupt(id: "int-2", reason: "R")
        XCTAssertNotEqual(a, b)
    }

    func test_equatable_differentReason_notEqual() {
        let a = Interrupt(id: "int-1", reason: "R1")
        let b = Interrupt(id: "int-1", reason: "R2")
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Hashable

    func test_hashable_sameValues_sameHash() {
        let a = Interrupt(id: "int-1", reason: "R")
        let b = Interrupt(id: "int-1", reason: "R")
        XCTAssertEqual(a.hashValue, b.hashValue)
    }

    func test_hashable_usableInSet() {
        let a = Interrupt(id: "int-1", reason: "R")
        let b = Interrupt(id: "int-2", reason: "R")
        let set: Set<Interrupt> = [a, b, a]
        XCTAssertEqual(set.count, 2)
    }
}
