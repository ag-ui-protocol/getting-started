// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the ActivityMessage type
final class ActivityMessageTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithBasicActivity() {
        let content = Data("""
        {
            "text": "Processing request..."
        }
        """.utf8)

        let message = ActivityMessage(
            id: "activity-1",
            activityType: "progress",
            content: content
        )

        XCTAssertEqual(message.id, "activity-1")
        XCTAssertEqual(message.activityType, "progress")
        XCTAssertEqual(message.role, .activity)
        XCTAssertFalse(message.content.isEmpty)
        XCTAssertNil(message.name)
    }

    func testInitWithComplexActivity() {
        let content = Data("""
        {
            "type": "chart",
            "data": {
                "labels": ["Jan", "Feb", "Mar"],
                "values": [10, 20, 30]
            }
        }
        """.utf8)

        let message = ActivityMessage(
            id: "activity-2",
            activityType: "visualization",
            content: content
        )

        XCTAssertEqual(message.activityType, "visualization")
        XCTAssertNotNil(message.content)
    }

    // MARK: - Message Protocol Conformance Tests

    func testConformsToMessageProtocol() {
        let content = Data("{}".utf8)
        let message: any Message = ActivityMessage(
            id: "activity-3",
            activityType: "status",
            content: content
        )

        XCTAssertEqual(message.id, "activity-3")
        XCTAssertEqual(message.role, .activity)
        XCTAssertNil(message.name)
    }

    func testRoleIsAlwaysActivity() {
        let content = Data("{}".utf8)
        let message = ActivityMessage(
            id: "1",
            activityType: "test",
            content: content
        )

        XCTAssertEqual(message.role, .activity)
    }

    // MARK: - Serialization Tests (via DTO)

    // Note: ActivityMessage no longer directly supports Codable.
    // Serialization is handled through ActivityMessageDTO and MessageDecoder.
    // These tests verify that the DTO layer works correctly.

    // MARK: - Decoding Tests (via MessageDecoder)

    func testDecodingBasicActivity() throws {
        let json = """
        {
            "id": "activity-decode-1",
            "role": "activity",
            "activityType": "progress",
            "content": {
                "percent": 75
            }
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ActivityMessage)
        let activityMessage = message as! ActivityMessage
        XCTAssertEqual(activityMessage.id, "activity-decode-1")
        XCTAssertEqual(activityMessage.role, .activity)
        XCTAssertEqual(activityMessage.activityType, "progress")
        XCTAssertFalse(activityMessage.content.isEmpty)
        XCTAssertNil(activityMessage.name)

        let activityContent = try JSONSerialization.jsonObject(with: activityMessage.content) as? [String: Any]
        XCTAssertEqual(activityContent?["percent"] as? Int, 75)
    }

    func testDecodingComplexActivity() throws {
        let json = """
        {
            "id": "activity-decode-2",
            "role": "activity",
            "activityType": "visualization",
            "content": {
                "type": "chart",
                "data": {
                    "labels": ["A", "B", "C"],
                    "values": [1, 2, 3]
                }
            }
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ActivityMessage)
        let activityMessage = message as! ActivityMessage
        XCTAssertEqual(activityMessage.activityType, "visualization")

        let content = try JSONSerialization.jsonObject(with: activityMessage.content) as? [String: Any]
        XCTAssertEqual(content?["type"] as? String, "chart")

        let data = content?["data"] as? [String: Any]
        let labels = data?["labels"] as? [String]
        XCTAssertEqual(labels, ["A", "B", "C"])
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "role": "activity",
            "activityType": "test",
            "content": {}
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithoutActivityType() {
        let json = """
        {
            "id": "activity-1",
            "role": "activity",
            "content": {}
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithoutActivityContent() {
        let json = """
        {
            "id": "activity-1",
            "role": "activity",
            "activityType": "test"
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithWrongRole() {
        let json = """
        {
            "id": "activity-1",
            "role": "user",
            "content": "Test message"
        }
        """

        // With polymorphic MessageDecoder, wrong role returns different message type
        let decoder = MessageDecoder()
        let message = try? decoder.decode(Data(json.utf8))

        // Should decode as UserMessage, not ActivityMessage
        XCTAssertNotNil(message)
        XCTAssertFalse(message is ActivityMessage)
        XCTAssertTrue(message is UserMessage)
    }

    // MARK: - Round-trip Tests (via DTO layer)

    func testRoundTripBasicActivity() throws {
        // Create original message
        let content = Data("""
        {"status": "complete"}
        """.utf8)

        let original = ActivityMessage(
            id: "activity-rt-1",
            activityType: "status",
            content: content
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let activityContentDict = try JSONSerialization.jsonObject(with: content) as? [String: Any]
        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "activityType": original.activityType,
            "content": activityContentDict as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is ActivityMessage)
        let activityMessage = decoded as! ActivityMessage
        XCTAssertEqual(activityMessage.id, original.id)
        XCTAssertEqual(activityMessage.activityType, original.activityType)
        XCTAssertEqual(activityMessage.role, original.role)

        let originalContent = try JSONSerialization.jsonObject(with: original.content) as? [String: Any]
        let decodedContent = try JSONSerialization.jsonObject(with: activityMessage.content) as? [String: Any]
        XCTAssertEqual(originalContent?["status"] as? String, decodedContent?["status"] as? String)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let content1 = Data("""
        {"value": 1}
        """.utf8)

        let content2 = Data("""
        {"value": 1}
        """.utf8)

        let content3 = Data("""
        {"value": 2}
        """.utf8)

        let message1 = ActivityMessage(id: "1", activityType: "test", content: content1)
        let message2 = ActivityMessage(id: "1", activityType: "test", content: content2)
        let message3 = ActivityMessage(id: "2", activityType: "test", content: content1)
        let message4 = ActivityMessage(id: "1", activityType: "other", content: content1)
        let message5 = ActivityMessage(id: "1", activityType: "test", content: content3)

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
        XCTAssertNotEqual(message1, message4)
        XCTAssertNotEqual(message1, message5)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let content1 = Data("""
        {"id": 1}
        """.utf8)

        let content2 = Data("""
        {"id": 2}
        """.utf8)

        let message1 = ActivityMessage(id: "1", activityType: "test", content: content1)
        let message2 = ActivityMessage(id: "2", activityType: "test", content: content2)

        let set: Set<ActivityMessage> = [message1, message2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(message1))
        XCTAssertTrue(set.contains(message2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let content = Data("{}".utf8)
        let message = ActivityMessage(
            id: "activity-concurrent",
            activityType: "test",
            content: content
        )

        Task {
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.id, "activity-concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testProgressIndicator() {
        let content = Data("""
        {
            "percent": 50,
            "message": "Processing files...",
            "current": 5,
            "total": 10
        }
        """.utf8)

        let progress = ActivityMessage(
            id: "progress-1",
            activityType: "progress",
            content: content
        )

        XCTAssertEqual(progress.activityType, "progress")
        XCTAssertEqual(progress.role, .activity)
    }

    func testA2UISurface() {
        let content = Data("""
        {
            "surfaceType": "form",
            "fields": [
                {"name": "email", "type": "text"},
                {"name": "submit", "type": "button"}
            ]
        }
        """.utf8)

        let surface = ActivityMessage(
            id: "surface-1",
            activityType: "a2ui-form",
            content: content
        )

        XCTAssertEqual(surface.activityType, "a2ui-form")
    }

    func testVisualization() {
        let content = Data("""
        {
            "chartType": "bar",
            "data": {
                "labels": ["Q1", "Q2", "Q3", "Q4"],
                "datasets": [
                    {"label": "Sales", "values": [100, 150, 120, 180]}
                ]
            }
        }
        """.utf8)

        let chart = ActivityMessage(
            id: "viz-1",
            activityType: "chart",
            content: content
        )

        XCTAssertEqual(chart.activityType, "chart")
    }

    func testStatusUpdate() {
        let content = Data("""
        {
            "status": "running",
            "step": "validation",
            "timestamp": "2024-01-01T12:00:00Z"
        }
        """.utf8)

        let status = ActivityMessage(
            id: "status-1",
            activityType: "status",
            content: content
        )

        XCTAssertEqual(status.activityType, "status")
        XCTAssertFalse(status.content.isEmpty)
    }

    // MARK: - Wire Format Tests (Protocol Compliance)

    func test_decodingUsesWireKey_content_notActivityContent() throws {
        // The AG-UI spec sends "content", not "activityContent"
        let json = """
        {
            "id": "wire-format-1",
            "role": "activity",
            "activityType": "progress",
            "content": {
                "percent": 80
            }
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is ActivityMessage)
        let activityMessage = message as! ActivityMessage
        XCTAssertEqual(activityMessage.id, "wire-format-1")
        XCTAssertEqual(activityMessage.activityType, "progress")
        let parsedContent = try JSONSerialization.jsonObject(with: activityMessage.content) as? [String: Any]
        XCTAssertEqual(parsedContent?["percent"] as? Int, 80)
    }

    func test_encodingWritesWireKey_content() throws {
        // The AG-UI spec expects "content" in the encoded output
        let rawContent = Data("{\"percent\":90}".utf8)
        let message = ActivityMessage(
            id: "wire-encode-1",
            activityType: "progress",
            content: rawContent
        )

        let encoder = MessageEncoder()
        let encoded = try encoder.encode(message)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertNotNil(json?["content"], "Encoded JSON must contain 'content' key (wire format)")
        XCTAssertNil(json?["activityContent"], "Encoded JSON must NOT contain old 'activityContent' key")
    }
}
