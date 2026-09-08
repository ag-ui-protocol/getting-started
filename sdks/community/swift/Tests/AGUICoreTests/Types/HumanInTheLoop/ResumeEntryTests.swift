// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class ResumeEntryTests: XCTestCase {

    // MARK: - Initialization

    func test_init_withRequiredFields_storesValues() {
        let entry = ResumeEntry(interruptId: "int-1", status: .resolved)

        XCTAssertEqual(entry.interruptId, "int-1")
        XCTAssertEqual(entry.status, .resolved)
        XCTAssertNil(entry.payload)
    }

    func test_init_withPayload_storesPayload() {
        let payload = Data(#"{"approved": true}"#.utf8)
        let entry = ResumeEntry(interruptId: "int-2", status: .cancelled, payload: payload)

        XCTAssertEqual(entry.interruptId, "int-2")
        XCTAssertEqual(entry.status, .cancelled)
        XCTAssertEqual(entry.payload, payload)
    }

    // MARK: - ResumeStatus

    func test_resumeStatus_resolvedRawValue() {
        XCTAssertEqual(ResumeEntry.ResumeStatus.resolved.rawValue, "resolved")
    }

    func test_resumeStatus_cancelledRawValue() {
        XCTAssertEqual(ResumeEntry.ResumeStatus.cancelled.rawValue, "cancelled")
    }

    // MARK: - Codable round-trip

    func test_codable_roundTrip_withoutPayload() throws {
        let original = ResumeEntry(interruptId: "int-1", status: .resolved)
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ResumeEntry.self, from: encoded)

        XCTAssertEqual(decoded.interruptId, original.interruptId)
        XCTAssertEqual(decoded.status, original.status)
        XCTAssertNil(decoded.payload)
    }

    func test_codable_roundTrip_withObjectPayload() throws {
        let payload = Data(#"{"approved":true,"comment":"LGTM"}"#.utf8)
        let original = ResumeEntry(interruptId: "int-full", status: .resolved, payload: payload)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ResumeEntry.self, from: encoded)

        XCTAssertEqual(decoded.interruptId, original.interruptId)
        XCTAssertEqual(decoded.status, original.status)

        // Verify payload survives as equivalent JSON
        let originalPayload = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
        let decodedPayloadData = try XCTUnwrap(decoded.payload)
        let decodedPayload = try JSONSerialization.jsonObject(with: decodedPayloadData) as? [String: Any]
        XCTAssertEqual(originalPayload?.keys.sorted(), decodedPayload?.keys.sorted())
    }

    func test_codable_roundTrip_withBooleanPayload() throws {
        // payload: z.any() — boolean is a valid JSON value.
        // Store as raw JSON bytes (JSONSerialization.data() rejects scalar top-level values).
        let payload = Data("true".utf8)
        let original = ResumeEntry(interruptId: "int-bool", status: .resolved, payload: payload)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ResumeEntry.self, from: encoded)

        let decodedPayloadData = try XCTUnwrap(decoded.payload)
        let decodedValue = try JSONSerialization.jsonObject(with: decodedPayloadData, options: .fragmentsAllowed)
        XCTAssertEqual(decodedValue as? Bool, true)
    }

    func test_codable_roundTrip_withIntegerPayload() throws {
        // payload: z.any() — integer is a valid JSON value.
        let payload = Data("42".utf8)
        let original = ResumeEntry(interruptId: "int-num", status: .resolved, payload: payload)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ResumeEntry.self, from: encoded)

        let decodedPayloadData = try XCTUnwrap(decoded.payload)
        let decodedValue = try JSONSerialization.jsonObject(with: decodedPayloadData, options: .fragmentsAllowed)
        XCTAssertEqual(decodedValue as? Int, 42)
    }

    func test_codable_roundTrip_withStringPayload() throws {
        // payload: z.any() — string is a valid JSON value.
        let payload = Data("\"user_response\"".utf8)
        let original = ResumeEntry(interruptId: "int-str", status: .resolved, payload: payload)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ResumeEntry.self, from: encoded)

        let decodedPayloadData = try XCTUnwrap(decoded.payload)
        let decodedValue = try JSONSerialization.jsonObject(with: decodedPayloadData, options: .fragmentsAllowed)
        XCTAssertEqual(decodedValue as? String, "user_response")
    }

    func test_codable_roundTrip_withArrayPayload() throws {
        // payload: z.any() — array is a valid JSON value.
        let payload = try JSONSerialization.data(withJSONObject: ["a", "b"])
        let original = ResumeEntry(interruptId: "int-arr", status: .resolved, payload: payload)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ResumeEntry.self, from: encoded)

        let decodedPayloadData = try XCTUnwrap(decoded.payload)
        let decodedValue = try JSONSerialization.jsonObject(with: decodedPayloadData) as? [String]
        XCTAssertEqual(decodedValue, ["a", "b"])
    }

    func test_codable_omitsPayloadKey_whenNil() throws {
        let entry = ResumeEntry(interruptId: "int-1", status: .resolved)
        let encoded = try JSONEncoder().encode(entry)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        XCTAssertNotNil(json["interruptId"])
        XCTAssertNotNil(json["status"])
        XCTAssertNil(json["payload"])
    }

    func test_codable_statusEncodesAsString() throws {
        let entry = ResumeEntry(interruptId: "int-1", status: .cancelled)
        let encoded = try JSONEncoder().encode(entry)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        XCTAssertEqual(json["status"] as? String, "cancelled")
    }

    func test_codable_decodesResolvedStatus() throws {
        let json = Data(#"{"interruptId":"int-1","status":"resolved"}"#.utf8)
        let entry = try JSONDecoder().decode(ResumeEntry.self, from: json)
        XCTAssertEqual(entry.status, .resolved)
    }

    func test_codable_decodesCancelledStatus() throws {
        let json = Data(#"{"interruptId":"int-1","status":"cancelled"}"#.utf8)
        let entry = try JSONDecoder().decode(ResumeEntry.self, from: json)
        XCTAssertEqual(entry.status, .cancelled)
    }

    // MARK: - Equatable

    func test_equatable_sameValues_areEqual() {
        let a = ResumeEntry(interruptId: "int-1", status: .resolved)
        let b = ResumeEntry(interruptId: "int-1", status: .resolved)
        XCTAssertEqual(a, b)
    }

    func test_equatable_differentInterruptId_notEqual() {
        let a = ResumeEntry(interruptId: "int-1", status: .resolved)
        let b = ResumeEntry(interruptId: "int-2", status: .resolved)
        XCTAssertNotEqual(a, b)
    }

    func test_equatable_differentStatus_notEqual() {
        let a = ResumeEntry(interruptId: "int-1", status: .resolved)
        let b = ResumeEntry(interruptId: "int-1", status: .cancelled)
        XCTAssertNotEqual(a, b)
    }

    func test_equatable_differentPayload_notEqual() {
        let a = ResumeEntry(interruptId: "int-1", status: .resolved, payload: Data("a".utf8))
        let b = ResumeEntry(interruptId: "int-1", status: .resolved, payload: Data("b".utf8))
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Hashable

    func test_hashable_usableInSet() {
        let a = ResumeEntry(interruptId: "int-1", status: .resolved)
        let b = ResumeEntry(interruptId: "int-2", status: .resolved)
        let set: Set<ResumeEntry> = [a, b, a]
        XCTAssertEqual(set.count, 2)
    }
}
