// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the State type alias
final class StateTests: XCTestCase {
    // MARK: - Type Alias Tests

    func testStateIsData() {
        // Verify State is a type alias for Data
        let state: State = Data()
        XCTAssertTrue(type(of: state) == Data.self)
    }

    // MARK: - JSON State Creation Tests

    func testCreateEmptyState() throws {
        let emptyObject = "{}"
        let state: State = Data(emptyObject.utf8)

        let json = try JSONSerialization.jsonObject(with: state) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?.count, 0)
    }

    func testCreateStateWithProperties() throws {
        let jsonString = """
        {
            "counter": 42,
            "name": "test",
            "enabled": true
        }
        """
        let state: State = Data(jsonString.utf8)

        let json = try JSONSerialization.jsonObject(with: state) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["counter"] as? Int, 42)
        XCTAssertEqual(json?["name"] as? String, "test")
        XCTAssertEqual(json?["enabled"] as? Bool, true)
    }

    func testCreateStateWithNestedObjects() throws {
        let jsonString = """
        {
            "user": {
                "id": "123",
                "preferences": {
                    "theme": "dark"
                }
            }
        }
        """
        let state: State = Data(jsonString.utf8)

        let json = try JSONSerialization.jsonObject(with: state) as? [String: Any]
        let user = json?["user"] as? [String: Any]
        let preferences = user?["preferences"] as? [String: Any]

        XCTAssertEqual(preferences?["theme"] as? String, "dark")
    }

    func testCreateStateWithArray() throws {
        let jsonString = """
        {
            "items": [1, 2, 3],
            "tags": ["swift", "testing"]
        }
        """
        let state: State = Data(jsonString.utf8)

        let json = try JSONSerialization.jsonObject(with: state) as? [String: Any]
        let items = json?["items"] as? [Int]
        let tags = json?["tags"] as? [String]

        XCTAssertEqual(items, [1, 2, 3])
        XCTAssertEqual(tags, ["swift", "testing"])
    }

    // MARK: - State Encoding/Decoding Tests

    func testEncodeCodableToState() throws {
        struct AppState: Codable {
            let counter: Int
            let message: String
        }

        let appState = AppState(counter: 100, message: "Hello")
        let state: State = try JSONEncoder().encode(appState)

        // Verify we can decode it back
        let decoded = try JSONDecoder().decode(AppState.self, from: state)
        XCTAssertEqual(decoded.counter, 100)
        XCTAssertEqual(decoded.message, "Hello")
    }

    func testDecodeStateIntoCodableType() throws {
        let jsonString = """
        {
            "value": 42,
            "label": "Answer"
        }
        """
        let state: State = Data(jsonString.utf8)

        struct StateModel: Codable {
            let value: Int
            let label: String
        }

        let decoded = try JSONDecoder().decode(StateModel.self, from: state)
        XCTAssertEqual(decoded.value, 42)
        XCTAssertEqual(decoded.label, "Answer")
    }

    // MARK: - State Manipulation Tests

    func testMutateStateData() throws {
        var state: State = Data("{}".utf8)

        // Replace with new state
        let newJsonString = """
        {
            "updated": true
        }
        """
        state = Data(newJsonString.utf8)

        let json = try JSONSerialization.jsonObject(with: state) as? [String: Any]
        XCTAssertEqual(json?["updated"] as? Bool, true)
    }

    func testStateEquality() {
        let state1: State = Data("{\"key\":\"value\"}".utf8)
        let state2: State = Data("{\"key\":\"value\"}".utf8)
        let state3: State = Data("{\"key\":\"other\"}".utf8)

        XCTAssertEqual(state1, state2)
        XCTAssertNotEqual(state1, state3)
    }

    // MARK: - Edge Cases

    func testEmptyState() {
        let state: State = Data()
        XCTAssertEqual(state.count, 0)
    }

    func testStateWithNullValue() throws {
        let jsonString = """
        {
            "nullable": null
        }
        """
        let state: State = Data(jsonString.utf8)

        let json = try JSONSerialization.jsonObject(with: state) as? [String: Any]
        XCTAssertTrue(json?["nullable"] is NSNull)
    }

    // MARK: - Sendable Conformance Tests

    func testStateIsSendable() {
        let state: State = Data("{}".utf8)

        Task {
            // If State (Data) is Sendable, this should compile without warnings
            let capturedState = state
            XCTAssertNotNil(capturedState)
        }
    }

    // MARK: - Real-world Usage Tests

    func testStateAsRunAgentInputParameter() throws {
        // Simulate how State would be used in RunAgentInput
        struct RunAgentInput: Codable {
            let threadId: String
            let state: State?

            init(threadId: String, state: State? = nil) {
                self.threadId = threadId
                self.state = state
            }
        }

        let appState = Data("""
        {
            "session": "abc123",
            "user_preferences": {
                "language": "en"
            }
        }
        """.utf8)

        let input = RunAgentInput(threadId: "thread-1", state: appState)

        // Verify encoding/decoding works
        let encoded = try JSONEncoder().encode(input)
        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)

        XCTAssertEqual(decoded.threadId, "thread-1")
        XCTAssertNotNil(decoded.state)
    }
}
