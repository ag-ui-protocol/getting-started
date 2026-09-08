// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import XCTest
@testable import ChatApp

// MARK: - Phase 4: A2UISurfaceStateManager Tests

@MainActor
final class A2UISurfaceStateManagerTests: XCTestCase {

    // MARK: - Helpers

    private func jsonData(_ dict: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: dict)
    }

    private func makeSnapshot(messageId: String, content: [String: Any]) -> ActivitySnapshotEvent {
        ActivitySnapshotEvent(
            messageId: messageId,
            activityType: "a2ui-surface",
            content: jsonData(content)
        )
    }

    private func makeDelta(messageId: String, operations: [[String: Any]]) -> ActivityDeltaEvent {
        ActivityDeltaEvent(
            messageId: messageId,
            activityType: "a2ui-surface",
            patch: try! JSONSerialization.data(withJSONObject: operations)
        )
    }

    // MARK: - Tests

    func test_applySnapshot_storesSurfaceData() {
        let manager = A2UISurfaceStateManager()
        let event = makeSnapshot(messageId: "m1", content: ["type": "text", "content": "Hello"])

        manager.applySnapshot(event)

        XCTAssertNotNil(manager.surfaceData(for: "m1"))
    }

    func test_applySnapshot_storesCorrectContent() throws {
        let manager = A2UISurfaceStateManager()
        let event = makeSnapshot(messageId: "m1", content: ["type": "text", "content": "Hello"])

        manager.applySnapshot(event)

        let stored = try XCTUnwrap(manager.surfaceData(for: "m1"))
        let dict = try JSONSerialization.jsonObject(with: stored) as! [String: Any]
        XCTAssertEqual(dict["type"] as? String, "text")
        XCTAssertEqual(dict["content"] as? String, "Hello")
    }

    func test_applyDelta_patchesCorrectly() throws {
        let manager = A2UISurfaceStateManager()
        manager.applySnapshot(makeSnapshot(messageId: "m1", content: ["type": "text", "content": "Hello"]))

        let delta = makeDelta(
            messageId: "m1",
            operations: [["op": "replace", "path": "/content", "value": "World"]]
        )
        let result = try manager.applyDelta(delta)

        let dict = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        XCTAssertEqual(dict["content"] as? String, "World")
    }

    func test_applyDelta_updatesStoredState() throws {
        let manager = A2UISurfaceStateManager()
        manager.applySnapshot(makeSnapshot(messageId: "m1", content: ["type": "text", "content": "Hello"]))

        let delta = makeDelta(
            messageId: "m1",
            operations: [["op": "replace", "path": "/content", "value": "Updated"]]
        )
        _ = try manager.applyDelta(delta)

        let stored = try XCTUnwrap(manager.surfaceData(for: "m1"))
        let dict = try JSONSerialization.jsonObject(with: stored) as! [String: Any]
        XCTAssertEqual(dict["content"] as? String, "Updated")
    }

    func test_applyDelta_throwsWhenNoSnapshot() {
        let manager = A2UISurfaceStateManager()
        let delta = makeDelta(
            messageId: "nonexistent",
            operations: [["op": "replace", "path": "/content", "value": "World"]]
        )

        XCTAssertThrowsError(try manager.applyDelta(delta))
    }

    func test_reset_clearsAllSurfaces() {
        let manager = A2UISurfaceStateManager()
        manager.applySnapshot(makeSnapshot(messageId: "m1", content: ["type": "text", "content": "Hello"]))
        manager.applySnapshot(makeSnapshot(messageId: "m2", content: ["type": "divider"]))

        manager.reset()

        XCTAssertNil(manager.surfaceData(for: "m1"))
        XCTAssertNil(manager.surfaceData(for: "m2"))
    }

    func test_multipleSurfaces_coexist() {
        let manager = A2UISurfaceStateManager()
        manager.applySnapshot(makeSnapshot(messageId: "s1", content: ["type": "text", "content": "Surface 1"]))
        manager.applySnapshot(makeSnapshot(messageId: "s2", content: ["type": "button", "label": "OK"]))

        XCTAssertNotNil(manager.surfaceData(for: "s1"))
        XCTAssertNotNil(manager.surfaceData(for: "s2"))
    }
}
