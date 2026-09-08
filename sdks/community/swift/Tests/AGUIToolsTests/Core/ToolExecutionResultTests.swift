// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUITools

final class ToolExecutionResultTests: XCTestCase {

    // MARK: - Success Cases

    func testSuccessResultWithNoData() {
        // Given: A successful result with no data
        let result = ToolExecutionResult.success()

        // Then: Result should be marked as successful
        XCTAssertTrue(result.success)
        XCTAssertNil(result.result)
        XCTAssertNil(result.message)
    }

    func testSuccessResultWithData() {
        // Given: JSON data for the result
        let jsonData = Data(#"{"temperature": 72, "conditions": "sunny"}"#.utf8)

        // When: Creating a successful result with data
        let result = ToolExecutionResult.success(result: jsonData)

        // Then: Result should contain the data
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.result, jsonData)
        XCTAssertNil(result.message)
    }

    func testSuccessResultWithMessage() {
        // Given: A success message
        let message = "Weather data retrieved successfully"

        // When: Creating a successful result with message
        let result = ToolExecutionResult.success(message: message)

        // Then: Result should contain the message
        XCTAssertTrue(result.success)
        XCTAssertNil(result.result)
        XCTAssertEqual(result.message, message)
    }

    func testSuccessResultWithDataAndMessage() {
        // Given: JSON data and a message
        let jsonData = Data(#"{"value": 42}"#.utf8)
        let message = "Calculation complete"

        // When: Creating a successful result with both
        let result = ToolExecutionResult.success(result: jsonData, message: message)

        // Then: Result should contain both
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.result, jsonData)
        XCTAssertEqual(result.message, message)
    }

    // MARK: - Failure Cases

    func testFailureResultWithMessage() {
        // Given: An error message
        let errorMessage = "Failed to connect to weather service"

        // When: Creating a failure result
        let result = ToolExecutionResult.failure(message: errorMessage)

        // Then: Result should be marked as failed
        XCTAssertFalse(result.success)
        XCTAssertNil(result.result)
        XCTAssertEqual(result.message, errorMessage)
    }

    func testFailureResultWithDataAndMessage() {
        // Given: Error data and message
        let errorData = Data(#"{"error_code": 404}"#.utf8)
        let errorMessage = "Resource not found"

        // When: Creating a failure result with both
        let result = ToolExecutionResult.failure(message: errorMessage, result: errorData)

        // Then: Result should contain both
        XCTAssertFalse(result.success)
        XCTAssertEqual(result.result, errorData)
        XCTAssertEqual(result.message, errorMessage)
    }

    // MARK: - Equatable Conformance

    func testEquatableSuccess() {
        // Given: Two identical successful results
        let jsonData = Data(#"{"value": 1}"#.utf8)
        let result1 = ToolExecutionResult.success(result: jsonData, message: "OK")
        let result2 = ToolExecutionResult.success(result: jsonData, message: "OK")

        // Then: They should be equal
        XCTAssertEqual(result1, result2)
    }

    func testEquatableFailure() {
        // Given: Two identical failure results
        let errorData = Data(#"{"error": "timeout"}"#.utf8)
        let result1 = ToolExecutionResult.failure(message: "Timeout", result: errorData)
        let result2 = ToolExecutionResult.failure(message: "Timeout", result: errorData)

        // Then: They should be equal
        XCTAssertEqual(result1, result2)
    }

    func testNotEqualDifferentSuccess() {
        // Given: Two different results
        let result1 = ToolExecutionResult.success(message: "OK")
        let result2 = ToolExecutionResult.failure(message: "Error")

        // Then: They should not be equal
        XCTAssertNotEqual(result1, result2)
    }

    // MARK: - Sendable Conformance

    func testSendableAcrossActors() async {
        // Given: A result
        let result = ToolExecutionResult.success(message: "Test")

        // When: Passing it to an actor
        actor ResultHolder {
            var result: ToolExecutionResult?

            func store(_ result: ToolExecutionResult) {
                self.result = result
            }
        }

        let holder = ResultHolder()
        await holder.store(result)

        // Then: No compiler errors (Sendable conformance)
        // This test verifies that ToolExecutionResult is Sendable
    }

    // MARK: - Edge Cases

    func testEmptyDataResult() {
        // Given: Empty data
        let emptyData = Data()

        // When: Creating a result with empty data
        let result = ToolExecutionResult.success(result: emptyData)

        // Then: Result should contain empty data
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.result, emptyData)
    }

    func testLargeDataResult() {
        // Given: Large JSON data
        let largeJSON = String(repeating: #"{"key":"value"},"#, count: 1000)
        let largeData = Data(("[\(largeJSON)]").utf8)

        // When: Creating a result with large data
        let result = ToolExecutionResult.success(result: largeData)

        // Then: Result should handle large data
        XCTAssertTrue(result.success)
        XCTAssertEqual(result.result, largeData)
    }
}
