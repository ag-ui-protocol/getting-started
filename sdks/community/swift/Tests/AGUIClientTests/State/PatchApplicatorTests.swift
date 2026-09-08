// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient

/// Comprehensive tests for RFC 6902 JSON Patch implementation.
///
/// Tests all standard JSON Patch operations:
/// - add: Adds a value to an object or array
/// - remove: Removes a value from an object or array
/// - replace: Replaces a value
/// - move: Moves a value from one location to another
/// - copy: Copies a value from one location to another
/// - test: Tests that a value at a path equals specified value
///
/// Each operation is tested with:
/// - Root-level paths
/// - Nested paths
/// - Array operations (index, append with "-")
/// - Edge cases and error conditions
final class PatchApplicatorTests: XCTestCase {
    var applicator: PatchApplicator!

    override func setUp() {
        super.setUp()
        applicator = PatchApplicator()
    }

    // MARK: - Add Operation Tests

    func testAddToEmptyObject() throws {
        let state = Data("{}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/name","value":"alice"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["name"] as? String, "alice")
    }

    func testAddMultipleFields() throws {
        let state = Data("{}".utf8)
        let patch = Data("""
        [
            {"op":"add","path":"/name","value":"alice"},
            {"op":"add","path":"/age","value":30}
        ]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["name"] as? String, "alice")
        XCTAssertEqual(json["age"] as? Int, 30)
    }

    func testAddNestedField() throws {
        let state = Data("{\"user\":{}}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/user/name","value":"alice"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let user = json["user"] as! [String: Any]

        XCTAssertEqual(user["name"] as? String, "alice")
    }

    func testAddToArrayAtIndex() throws {
        let state = Data("{\"items\":[\"a\",\"b\"]}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/items/1","value":"x"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let items = json["items"] as! [String]

        XCTAssertEqual(items, ["a", "x", "b"])
    }

    func testAddToArrayEnd() throws {
        let state = Data("{\"items\":[\"a\",\"b\"]}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/items/-","value":"c"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let items = json["items"] as! [String]

        XCTAssertEqual(items, ["a", "b", "c"])
    }

    func testAddComplexValue() throws {
        let state = Data("{}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/user","value":{"name":"alice","age":30}}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let user = json["user"] as! [String: Any]

        XCTAssertEqual(user["name"] as? String, "alice")
        XCTAssertEqual(user["age"] as? Int, 30)
    }

    // MARK: - Remove Operation Tests

    func testRemoveField() throws {
        let state = Data("{\"name\":\"alice\",\"age\":30}".utf8)
        let patch = Data("""
        [{"op":"remove","path":"/age"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["name"] as? String, "alice")
        XCTAssertNil(json["age"])
    }

    func testRemoveNestedField() throws {
        let state = Data("{\"user\":{\"name\":\"alice\",\"age\":30}}".utf8)
        let patch = Data("""
        [{"op":"remove","path":"/user/age"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let user = json["user"] as! [String: Any]

        XCTAssertEqual(user["name"] as? String, "alice")
        XCTAssertNil(user["age"])
    }

    func testRemoveArrayElement() throws {
        let state = Data("{\"items\":[\"a\",\"b\",\"c\"]}".utf8)
        let patch = Data("""
        [{"op":"remove","path":"/items/1"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let items = json["items"] as! [String]

        XCTAssertEqual(items, ["a", "c"])
    }

    func testRemoveNonExistentFieldThrowsError() throws {
        let state = Data("{\"name\":\"alice\"}".utf8)
        let patch = Data("""
        [{"op":"remove","path":"/age"}]
        """.utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    // MARK: - Replace Operation Tests

    func testReplaceField() throws {
        let state = Data("{\"count\":5}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/count","value":10}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["count"] as? Int, 10)
    }

    func testReplaceNestedField() throws {
        let state = Data("{\"user\":{\"name\":\"alice\"}}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/user/name","value":"bob"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let user = json["user"] as! [String: Any]

        XCTAssertEqual(user["name"] as? String, "bob")
    }

    func testReplaceArrayElement() throws {
        let state = Data("{\"items\":[\"a\",\"b\",\"c\"]}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/items/1","value":"x"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let items = json["items"] as! [String]

        XCTAssertEqual(items, ["a", "x", "c"])
    }

    func testReplaceWithDifferentType() throws {
        let state = Data("{\"value\":\"string\"}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/value","value":42}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["value"] as? Int, 42)
    }

    func testReplaceNonExistentFieldThrowsError() throws {
        let state = Data("{\"name\":\"alice\"}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/age","value":30}]
        """.utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    // MARK: - Move Operation Tests

    func testMoveField() throws {
        let state = Data("{\"a\":1,\"b\":2}".utf8)
        let patch = Data("""
        [{"op":"move","from":"/a","path":"/c"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertNil(json["a"])
        XCTAssertEqual(json["b"] as? Int, 2)
        XCTAssertEqual(json["c"] as? Int, 1)
    }

    func testMoveArrayElement() throws {
        let state = Data("{\"items\":[\"a\",\"b\",\"c\"]}".utf8)
        let patch = Data("""
        [{"op":"move","from":"/items/0","path":"/items/2"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let items = json["items"] as! [String]

        XCTAssertEqual(items, ["b", "c", "a"])
    }

    func testMoveToNestedPath() throws {
        let state = Data("{\"value\":42,\"nested\":{}}".utf8)
        let patch = Data("""
        [{"op":"move","from":"/value","path":"/nested/value"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let nested = json["nested"] as! [String: Any]

        XCTAssertNil(json["value"])
        XCTAssertEqual(nested["value"] as? Int, 42)
    }

    // MARK: - Copy Operation Tests

    func testCopyField() throws {
        let state = Data("{\"original\":\"value\"}".utf8)
        let patch = Data("""
        [{"op":"copy","from":"/original","path":"/copy"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["original"] as? String, "value")
        XCTAssertEqual(json["copy"] as? String, "value")
    }

    func testCopyArrayElement() throws {
        let state = Data("{\"items\":[\"a\",\"b\"]}".utf8)
        let patch = Data("""
        [{"op":"copy","from":"/items/0","path":"/items/-"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let items = json["items"] as! [String]

        XCTAssertEqual(items, ["a", "b", "a"])
    }

    func testCopyComplexValue() throws {
        let state = Data("{\"user\":{\"name\":\"alice\",\"age\":30}}".utf8)
        let patch = Data("""
        [{"op":"copy","from":"/user","path":"/backup"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let user = json["user"] as! [String: Any]
        let backup = json["backup"] as! [String: Any]

        XCTAssertEqual(user["name"] as? String, "alice")
        XCTAssertEqual(backup["name"] as? String, "alice")
        XCTAssertEqual(backup["age"] as? Int, 30)
    }

    // MARK: - Test Operation Tests

    func testTestOperationSuccess() throws {
        let state = Data("{\"value\":42}".utf8)
        let patch = Data("""
        [{"op":"test","path":"/value","value":42}]
        """.utf8)

        // Should not throw
        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        XCTAssertEqual(json["value"] as? Int, 42)
    }

    func testTestOperationFailure() throws {
        let state = Data("{\"value\":42}".utf8)
        let patch = Data("""
        [{"op":"test","path":"/value","value":100}]
        """.utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testTestOperationWithString() throws {
        let state = Data("{\"name\":\"alice\"}".utf8)
        let patch = Data("""
        [{"op":"test","path":"/name","value":"alice"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        XCTAssertEqual(json["name"] as? String, "alice")
    }

    func testTestOperationWithNull() throws {
        let state = Data("{\"value\":null}".utf8)
        let patch = Data("""
        [{"op":"test","path":"/value","value":null}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        XCTAssertTrue(json["value"] is NSNull)
    }

    // MARK: - Complex Scenarios

    func testMultipleOperationsInSequence() throws {
        let state = Data("{\"a\":1,\"b\":2}".utf8)
        let patch = Data("""
        [
            {"op":"add","path":"/c","value":3},
            {"op":"replace","path":"/a","value":10},
            {"op":"remove","path":"/b"},
            {"op":"add","path":"/d","value":4}
        ]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json["a"] as? Int, 10)
        XCTAssertNil(json["b"])
        XCTAssertEqual(json["c"] as? Int, 3)
        XCTAssertEqual(json["d"] as? Int, 4)
    }

    func testDeeplyNestedOperations() throws {
        let state = Data("{\"level1\":{\"level2\":{\"level3\":{\"value\":1}}}}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/level1/level2/level3/value","value":999}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let level1 = json["level1"] as! [String: Any]
        let level2 = level1["level2"] as! [String: Any]
        let level3 = level2["level3"] as! [String: Any]

        XCTAssertEqual(level3["value"] as? Int, 999)
    }

    func testMixedArrayAndObjectOperations() throws {
        let state = Data("{\"users\":[{\"name\":\"alice\"},{\"name\":\"bob\"}]}".utf8)
        let patch = Data("""
        [{"op":"replace","path":"/users/0/name","value":"charlie"}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let users = json["users"] as! [[String: Any]]

        XCTAssertEqual(users[0]["name"] as? String, "charlie")
        XCTAssertEqual(users[1]["name"] as? String, "bob")
    }

    // MARK: - Error Handling Tests

    func testInvalidJSONThrowsError() throws {
        let state = Data("{invalid json}".utf8)
        let patch = Data("[{\"op\":\"add\",\"path\":\"/a\",\"value\":1}]".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testInvalidPatchJSONThrowsError() throws {
        let state = Data("{}".utf8)
        let patch = Data("{not an array}".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testMissingOpFieldThrowsError() throws {
        let state = Data("{}".utf8)
        let patch = Data("[{\"path\":\"/a\",\"value\":1}]".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testMissingPathFieldThrowsError() throws {
        let state = Data("{}".utf8)
        let patch = Data("[{\"op\":\"add\",\"value\":1}]".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testUnknownOperationThrowsError() throws {
        let state = Data("{}".utf8)
        let patch = Data("[{\"op\":\"invalid\",\"path\":\"/a\",\"value\":1}]".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testInvalidPathThrowsError() throws {
        let state = Data("{}".utf8)
        let patch = Data("[{\"op\":\"add\",\"path\":\"invalid\",\"value\":1}]".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    func testArrayIndexOutOfBoundsThrowsError() throws {
        let state = Data("{\"items\":[\"a\"]}".utf8)
        let patch = Data("[{\"op\":\"remove\",\"path\":\"/items/5\"}]".utf8)

        XCTAssertThrowsError(try applicator.apply(patch: patch, to: state))
    }

    // MARK: - Edge Cases

    func testEmptyPatchReturnsOriginalState() throws {
        let state = Data("{\"value\":42}".utf8)
        let patch = Data("[]".utf8)

        let result = try applicator.apply(patch: patch, to: state)

        XCTAssertEqual(result, state)
    }

    func testAddToRootPath() throws {
        let state = Data("{}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/","value":"myValue"}]
        """.utf8)

        // Per RFC 6901: "/" refers to the empty-string key "", not the root document.
        // add with path "/" sets the member keyed by "" in the root object.
        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        XCTAssertEqual(json[""] as? String, "myValue")
    }

    // MARK: - RFC 6901: empty-string path segments

    func test_rfc6901_emptySegmentInPath_isPreserved() throws {
        // /a//b decodes to ["a", "", "b"] per RFC 6901.
        // Before fix: split(separator:) with default omittingEmptySubsequences: true
        // collapses the empty segment to ["a", "b"], silently targeting the wrong key.
        let state = Data("""
        {"a":{"":{"b":0}}}
        """.utf8)
        let patch = Data("""
        [{"op":"replace","path":"/a//b","value":42}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        let inner = json["a"] as! [String: Any]
        let empty = inner[""] as! [String: Any]
        XCTAssertEqual(empty["b"] as? Int, 42)
    }

    func testEscapedPathCharacters() throws {
        let state = Data("{}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/a~1b","value":1}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        // ~1 should be unescaped to /
        XCTAssertEqual(json["a/b"] as? Int, 1)
    }

    func testTildeEscaping() throws {
        let state = Data("{}".utf8)
        let patch = Data("""
        [{"op":"add","path":"/a~0b","value":1}]
        """.utf8)

        let result = try applicator.apply(patch: patch, to: state)
        let json = try JSONSerialization.jsonObject(with: result) as! [String: Any]

        // ~0 should be unescaped to ~
        XCTAssertEqual(json["a~b"] as? Int, 1)
    }
}
