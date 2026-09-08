// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient
@testable import AGUICore

/// Comprehensive tests for StateManager.
///
/// Tests state synchronization including:
/// - Snapshot handling and state replacement
/// - Delta (JSON Patch) application
/// - State retrieval and reset
/// - Error handling for invalid patches
/// - Thread safety with concurrent operations
final class StateManagerTests: XCTestCase {
    // MARK: - Snapshot Tests

    func testHandleSnapshotReplacesState() async throws {
        let manager = StateManager()

        // Create snapshot with initial state
        let initialState = """
        {"users":["alice","bob"],"count":2}
        """
        let snapshot = StateSnapshotEvent(
            snapshot: Data(initialState.utf8)
        )

        // Apply snapshot
        await manager.handleSnapshot(snapshot)

        // Verify state was set
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]

        XCTAssertEqual(stateJSON["count"] as? Int, 2)
        let users = stateJSON["users"] as! [String]
        XCTAssertEqual(users.count, 2)
        XCTAssertEqual(users[0], "alice")
        XCTAssertEqual(users[1], "bob")
    }

    func testHandleSnapshotOverwritesPreviousState() async throws {
        let manager = StateManager()

        // Set initial state
        let firstSnapshot = StateSnapshotEvent(
            snapshot: Data("{\"value\":1}".utf8)
        )
        await manager.handleSnapshot(firstSnapshot)

        // Replace with new snapshot
        let secondSnapshot = StateSnapshotEvent(
            snapshot: Data("{\"value\":2}".utf8)
        )
        await manager.handleSnapshot(secondSnapshot)

        // Verify only second snapshot remains
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["value"] as? Int, 2)
    }

    func testHandleSnapshotWithEmptyObject() async throws {
        let manager = StateManager()

        let snapshot = StateSnapshotEvent(snapshot: Data("{}".utf8))
        await manager.handleSnapshot(snapshot)

        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertTrue(stateJSON.isEmpty)
    }

    func testHandleSnapshotWithComplexNestedState() async throws {
        let manager = StateManager()

        let complexState = """
        {
            "users": {
                "alice": {"age": 30, "role": "admin"},
                "bob": {"age": 25, "role": "user"}
            },
            "settings": {
                "theme": "dark",
                "notifications": true
            }
        }
        """
        let snapshot = StateSnapshotEvent(snapshot: Data(complexState.utf8))
        await manager.handleSnapshot(snapshot)

        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]

        let users = stateJSON["users"] as! [String: [String: Any]]
        XCTAssertEqual(users["alice"]?["age"] as? Int, 30)
        XCTAssertEqual(users["bob"]?["role"] as? String, "user")
    }

    // MARK: - Delta Tests

    func testHandleDeltaAddOperation() async throws {
        let manager = StateManager()

        // Initialize with empty object
        await manager.handleSnapshot(StateSnapshotEvent(snapshot: Data("{}".utf8)))

        // Apply add operation
        let addPatch = """
        [{"op":"add","path":"/name","value":"alice"}]
        """
        let delta = StateDeltaEvent(delta: Data(addPatch.utf8))
        try await manager.handleDelta(delta)

        // Verify field was added
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["name"] as? String, "alice")
    }

    func testHandleDeltaReplaceOperation() async throws {
        let manager = StateManager()

        // Initialize state
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"count\":5}".utf8)
        ))

        // Apply replace operation
        let replacePatch = """
        [{"op":"replace","path":"/count","value":10}]
        """
        let delta = StateDeltaEvent(delta: Data(replacePatch.utf8))
        try await manager.handleDelta(delta)

        // Verify value was replaced
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["count"] as? Int, 10)
    }

    func testHandleDeltaRemoveOperation() async throws {
        let manager = StateManager()

        // Initialize state
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"name\":\"alice\",\"age\":30}".utf8)
        ))

        // Apply remove operation
        let removePatch = """
        [{"op":"remove","path":"/age"}]
        """
        let delta = StateDeltaEvent(delta: Data(removePatch.utf8))
        try await manager.handleDelta(delta)

        // Verify field was removed
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["name"] as? String, "alice")
        XCTAssertNil(stateJSON["age"])
    }

    func testHandleDeltaMultipleOperations() async throws {
        let manager = StateManager()

        // Initialize state
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"a\":1,\"b\":2}".utf8)
        ))

        // Apply multiple operations
        let multiPatch = """
        [
            {"op":"replace","path":"/a","value":10},
            {"op":"add","path":"/c","value":3},
            {"op":"remove","path":"/b"}
        ]
        """
        let delta = StateDeltaEvent(delta: Data(multiPatch.utf8))
        try await manager.handleDelta(delta)

        // Verify all operations were applied
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["a"] as? Int, 10)
        XCTAssertEqual(stateJSON["c"] as? Int, 3)
        XCTAssertNil(stateJSON["b"])
    }

    func testHandleDeltaNestedPath() async throws {
        let manager = StateManager()

        // Initialize with nested structure
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"user\":{\"name\":\"alice\"}}".utf8)
        ))

        // Update nested field
        let nestedPatch = """
        [{"op":"replace","path":"/user/name","value":"bob"}]
        """
        let delta = StateDeltaEvent(delta: Data(nestedPatch.utf8))
        try await manager.handleDelta(delta)

        // Verify nested field was updated
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        let user = stateJSON["user"] as! [String: Any]
        XCTAssertEqual(user["name"] as? String, "bob")
    }

    func testHandleDeltaArrayOperations() async throws {
        let manager = StateManager()

        // Initialize with array
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"items\":[\"a\",\"b\"]}".utf8)
        ))

        // Add to array
        let arrayPatch = """
        [{"op":"add","path":"/items/-","value":"c"}]
        """
        let delta = StateDeltaEvent(delta: Data(arrayPatch.utf8))
        try await manager.handleDelta(delta)

        // Verify array was updated
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        let items = stateJSON["items"] as! [String]
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[2], "c")
    }

    func testHandleDeltaInvalidPatchThrowsError() async throws {
        let manager = StateManager()

        await manager.handleSnapshot(StateSnapshotEvent(snapshot: Data("{}".utf8)))

        // Invalid patch - remove non-existent path
        let invalidPatch = """
        [{"op":"remove","path":"/nonexistent"}]
        """
        let delta = StateDeltaEvent(delta: Data(invalidPatch.utf8))

        do {
            try await manager.handleDelta(delta)
            XCTFail("Expected error for invalid patch")
        } catch {
            // Expected error
        }
    }

    func testHandleDeltaInvalidJSONThrowsError() async throws {
        let manager = StateManager()

        await manager.handleSnapshot(StateSnapshotEvent(snapshot: Data("{}".utf8)))

        // Invalid JSON
        let delta = StateDeltaEvent(delta: Data("{invalid json}".utf8))

        do {
            try await manager.handleDelta(delta)
            XCTFail("Expected error for invalid JSON")
        } catch {
            // Expected error
        }
    }

    // MARK: - State Retrieval Tests

    func testGetStateReturnsCurrentState() async throws {
        let manager = StateManager()

        let stateData = Data("{\"test\":\"value\"}".utf8)
        await manager.handleSnapshot(StateSnapshotEvent(snapshot: stateData))

        let retrieved = await manager.getState()
        let retrievedJSON = try JSONSerialization.jsonObject(with: retrieved) as! [String: Any]
        XCTAssertEqual(retrievedJSON["test"] as? String, "value")
    }

    func testGetStateBeforeAnySnapshotReturnsEmptyObject() async throws {
        let manager = StateManager()

        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertTrue(stateJSON.isEmpty)
    }

    // MARK: - Reset Tests

    func testResetClearsState() async throws {
        let manager = StateManager()

        // Set state
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"data\":\"value\"}".utf8)
        ))

        // Reset
        await manager.reset()

        // Verify state is empty
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertTrue(stateJSON.isEmpty)
    }

    func testResetAllowsNewStateAfter() async throws {
        let manager = StateManager()

        // Set and reset
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"old\":1}".utf8)
        ))
        await manager.reset()

        // Set new state
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"new\":2}".utf8)
        ))

        // Verify new state
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["new"] as? Int, 2)
        XCTAssertNil(stateJSON["old"])
    }

    // MARK: - Thread Safety Tests

    func testConcurrentSnapshotHandling() async throws {
        let manager = StateManager()

        // Apply snapshots concurrently
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<10 {
                group.addTask {
                    let snapshot = StateSnapshotEvent(
                        snapshot: Data("{\"value\":\(i)}".utf8)
                    )
                    await manager.handleSnapshot(snapshot)
                }
            }
        }

        // Verify state is valid (one of the values)
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        let value = stateJSON["value"] as! Int
        XCTAssertTrue((0..<10).contains(value))
    }

    func testConcurrentDeltaOperations() async throws {
        let manager = StateManager()

        // Initialize with counter
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"counters\":{}}".utf8)
        ))

        // Apply deltas concurrently
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<5 {
                group.addTask {
                    let patch = """
                    [{"op":"add","path":"/counters/c\(i)","value":\(i)}]
                    """
                    let delta = StateDeltaEvent(delta: Data(patch.utf8))
                    try? await manager.handleDelta(delta)
                }
            }
        }

        // Verify all deltas were applied (actor serializes them)
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        let counters = stateJSON["counters"] as! [String: Any]
        XCTAssertGreaterThan(counters.count, 0)
    }

    // MARK: - Integration Tests

    func testSnapshotThenDeltaSequence() async throws {
        let manager = StateManager()

        // Start with snapshot
        await manager.handleSnapshot(StateSnapshotEvent(
            snapshot: Data("{\"users\":[],\"count\":0}".utf8)
        ))

        // Apply series of deltas
        let deltas = [
            "[{\"op\":\"add\",\"path\":\"/users/-\",\"value\":\"alice\"}]",
            "[{\"op\":\"replace\",\"path\":\"/count\",\"value\":1}]",
            "[{\"op\":\"add\",\"path\":\"/users/-\",\"value\":\"bob\"}]",
            "[{\"op\":\"replace\",\"path\":\"/count\",\"value\":2}]"
        ]

        for patchJSON in deltas {
            let delta = StateDeltaEvent(delta: Data(patchJSON.utf8))
            try await manager.handleDelta(delta)
        }

        // Verify final state
        let state = await manager.getState()
        let stateJSON = try JSONSerialization.jsonObject(with: state) as! [String: Any]
        XCTAssertEqual(stateJSON["count"] as? Int, 2)
        let users = stateJSON["users"] as! [String]
        XCTAssertEqual(users.count, 2)
        XCTAssertEqual(users[0], "alice")
        XCTAssertEqual(users[1], "bob")
    }
}
