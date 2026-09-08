// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class StateDeltaEventTests: XCTestCase,
                                   AGUIEventDecoderTestHelpers,
                                   EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "delta": [
                ["op": "add", "path": "/foo", "value": "bar"]
            ]
        ]
    }

    var eventTypeString: String { "STATE_DELTA" }
    var expectedEventType: EventType { .stateDelta }
    var unknownEventTypeString: String { "STATE_UPDATE" }

    // MARK: - Feature: Decode STATE_DELTA

    func test_decodeValidStateDelta_withAddOperation_returnsStateDeltaEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" }
          ]
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let stateDelta = event as? StateDeltaEvent else {
            return XCTFail("Expected StateDeltaEvent, got \(type(of: event))")
        }
        XCTAssertEqual(stateDelta.eventType, .stateDelta)
        XCTAssertNil(stateDelta.timestamp)

        // Verify delta can be parsed
        let parsed = try stateDelta.parsedDelta()
        XCTAssertEqual(parsed.count, 1)
        if let operation = parsed[0] as? [String: Any] {
            XCTAssertEqual(operation["op"] as? String, "add")
            XCTAssertEqual(operation["path"] as? String, "/foo")
            XCTAssertEqual(operation["value"] as? String, "bar")
        } else {
            XCTFail("Expected operation to be a dictionary")
        }
    }

    func test_decodeStateDelta_withMultipleOperations_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" },
            { "op": "remove", "path": "/baz" },
            { "op": "replace", "path": "/foo", "value": "baz" }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        let parsed = try stateDelta.parsedDelta()
        XCTAssertEqual(parsed.count, 3)
    }

    func test_decodeStateDelta_withAllOperationTypes_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" },
            { "op": "remove", "path": "/baz" },
            { "op": "replace", "path": "/foo", "value": "baz" },
            { "op": "move", "from": "/foo", "path": "/bar" },
            { "op": "copy", "from": "/bar", "path": "/baz" },
            { "op": "test", "path": "/foo", "value": "baz" }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        let parsed = try stateDelta.parsedDelta()
        XCTAssertEqual(parsed.count, 6)
        
        // Verify operation types
        let operations = parsed.compactMap { $0 as? [String: Any] }
        let ops = operations.compactMap { $0["op"] as? String }
        XCTAssertTrue(ops.contains("add"))
        XCTAssertTrue(ops.contains("remove"))
        XCTAssertTrue(ops.contains("replace"))
        XCTAssertTrue(ops.contains("move"))
        XCTAssertTrue(ops.contains("copy"))
        XCTAssertTrue(ops.contains("test"))
    }

    func test_decodeStateDelta_withEmptyArray_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": []
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        let parsed = try stateDelta.parsedDelta()
        XCTAssertEqual(parsed.count, 0)
    }

    func test_decodeStateDelta_withComplexOperations_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            {
              "op": "add",
              "path": "/users/0",
              "value": { "id": 1, "name": "Alice", "roles": ["admin", "user"] }
            },
            {
              "op": "replace",
              "path": "/metadata/version",
              "value": "2.0"
            }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        let parsed = try stateDelta.parsedDelta()
        XCTAssertEqual(parsed.count, 2)
        
        if let firstOp = parsed[0] as? [String: Any] {
            XCTAssertEqual(firstOp["op"] as? String, "add")
            XCTAssertEqual(firstOp["path"] as? String, "/users/0")
            if let value = firstOp["value"] as? [String: Any] {
                XCTAssertEqual(value["name"] as? String, "Alice")
            } else {
                XCTFail("Expected value to be a dictionary")
            }
        }
    }

    func test_decodeStateDelta_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" }
          ],
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        XCTAssertEqual(stateDelta.timestamp, EventTestData.timestamp)
    }

    func test_decodeStateDelta_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" }
          ],
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        XCTAssertEqual(stateDelta.rawEvent, data)
    }

    func test_decodeStateDelta_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" }
          ],
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        let parsed = try stateDelta.parsedDelta()
        XCTAssertEqual(parsed.count, 1)
    }

    func test_decodeStateDelta_withUnicodeInOperations_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/message", "value": "Hello, 🌍! 你好" },
            { "op": "add", "path": "/city", "value": "北京" }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let stateDelta = try XCTUnwrap(event as? StateDeltaEvent)
        let parsed = try stateDelta.parsedDelta()
        if let firstOp = parsed[0] as? [String: Any] {
            XCTAssertEqual(firstOp["value"] as? String, "Hello, 🌍! 你好")
        }
        if let secondOp = parsed[1] as? [String: Any] {
            XCTAssertEqual(secondOp["value"] as? String, "北京")
        }
    }

    // MARK: - Feature: Error handling

    func test_decodeStateDelta_missingDelta_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("delta") || message.contains("Missing key"))
        }
    }

    func test_decodeStateDelta_deltaNotArray_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": { "op": "add", "path": "/foo", "value": "bar" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("array") || message.contains("Type mismatch"))
        }
    }

    func test_decodeStateDelta_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "STATE_DELTA",
          "delta": [
            { "op": "add", "path": "/foo", "value": "bar" }
          ],
          "timestamp": "not-a-number"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("timestamp") || message.contains("Type mismatch"))
        }
    }

    // MARK: - Feature: Model behaviors

    func test_stateDeltaEvent_eventTypeIsAlwaysStateDelta() throws {
        // Given
        let deltaData = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event = StateDeltaEvent(delta: deltaData, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .stateDelta)
    }

    func test_stateDeltaEvent_equatable_sameDeltas_areEqual() throws {
        // Given
        let deltaData = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event1 = StateDeltaEvent(delta: deltaData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = StateDeltaEvent(delta: deltaData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_stateDeltaEvent_equatable_differentDeltas_areNotEqual() throws {
        // Given
        let deltaData1 = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let deltaData2 = try JSONSerialization.data(withJSONObject: [["op": "remove", "path": "/foo"]], options: [])
        let event1 = StateDeltaEvent(delta: deltaData1, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = StateDeltaEvent(delta: deltaData2, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_stateDeltaEvent_equatable_differentTimestamps_areNotEqual() throws {
        // Given
        let deltaData = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event1 = StateDeltaEvent(delta: deltaData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = StateDeltaEvent(delta: deltaData, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_stateDeltaEvent_equatable_oneWithTimestampOneWithout_areNotEqual() throws {
        // Given
        let deltaData = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event1 = StateDeltaEvent(delta: deltaData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = StateDeltaEvent(delta: deltaData, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_stateDeltaEvent_parsedDelta_returnsCorrectValue() throws {
        // Given
        let originalDelta: [[String: Any]] = [
            ["op": "add", "path": "/foo", "value": "bar"],
            ["op": "remove", "path": "/baz"]
        ]
        let deltaData = try JSONSerialization.data(withJSONObject: originalDelta, options: [])
        let event = StateDeltaEvent(delta: deltaData, timestamp: nil, rawEvent: nil)

        // When
        let parsed = try event.parsedDelta()

        // Then
        XCTAssertEqual(parsed.count, 2)
        if let firstOp = parsed[0] as? [String: Any] {
            XCTAssertEqual(firstOp["op"] as? String, "add")
            XCTAssertEqual(firstOp["path"] as? String, "/foo")
        }
    }

    func test_stateDeltaEvent_parsedDelta_withInvalidData_throws() throws {
        // Given
        let invalidData = Data("not json".utf8)
        let event = StateDeltaEvent(delta: invalidData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedDelta())
    }

    func test_stateDeltaEvent_parsedDelta_withNonArrayData_throws() throws {
        // Given
        let nonArrayData = try JSONSerialization.data(withJSONObject: ["op": "add", "path": "/foo"], options: [])
        let event = StateDeltaEvent(delta: nonArrayData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedDelta()) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func test_stateDeltaEvent_parsedDeltaAs_withCodableType_decodesCorrectly() throws {
        // Given
        struct PatchOperation: Codable {
            let op: String
            let path: String
            let value: String?
        }

        let originalDelta = [
            PatchOperation(op: "add", path: "/foo", value: "bar"),
            PatchOperation(op: "remove", path: "/baz", value: nil)
        ]
        let deltaData = try JSONEncoder().encode(originalDelta)
        let event = StateDeltaEvent(delta: deltaData, timestamp: nil, rawEvent: nil)

        // When
        let decoded = try event.parsedDelta(as: PatchOperation.self)

        // Then
        XCTAssertEqual(decoded.count, 2)
        XCTAssertEqual(decoded[0].op, "add")
        XCTAssertEqual(decoded[0].path, "/foo")
        XCTAssertEqual(decoded[0].value, "bar")
        XCTAssertEqual(decoded[1].op, "remove")
        XCTAssertEqual(decoded[1].path, "/baz")
        XCTAssertNil(decoded[1].value)
    }

    func test_stateDeltaEvent_parsedDeltaAs_withWrongType_throws() throws {
        // Given
        struct PatchOperation: Codable {
            let op: String
            let path: String
        }

        struct WrongOperation: Decodable {
            let wrongField: String
        }

        let originalDelta = [PatchOperation(op: "add", path: "/foo")]
        let deltaData = try JSONEncoder().encode(originalDelta)
        let event = StateDeltaEvent(delta: deltaData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedDelta(as: WrongOperation.self)) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }
}
