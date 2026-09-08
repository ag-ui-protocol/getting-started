// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient

final class ClientErrorTests: XCTestCase {
    // MARK: - Error Description Tests

    func testInvalidURLErrorDescription() {
        let error = ClientError.invalidURL
        XCTAssertEqual(error.errorDescription, "Invalid URL configuration")
    }

    func testInvalidResponseErrorDescription() {
        let error = ClientError.invalidResponse
        XCTAssertEqual(error.errorDescription, "Received invalid response from server")
    }

    func testHttpErrorDescription() {
        let error = ClientError.httpError(statusCode: 404)
        XCTAssertEqual(error.errorDescription, "HTTP error: 404")
    }

    func testNetworkErrorDescription() {
        let networkError = NSError(domain: "TestDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Connection failed"])
        let error = ClientError.networkError(networkError)
        XCTAssertTrue(error.errorDescription?.contains("Network error") == true)
    }

    func testDecodingErrorDescription() {
        let decodingError = NSError(domain: "DecodingDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON"])
        let error = ClientError.decodingError(decodingError)
        XCTAssertTrue(error.errorDescription?.contains("Failed to decode event") == true)
    }

    func testStreamErrorDescription() {
        let error = ClientError.streamError("Buffer overflow")
        XCTAssertEqual(error.errorDescription, "Stream error: Buffer overflow")
    }

    func testTimeoutErrorDescription() {
        let error = ClientError.timeout
        XCTAssertEqual(error.errorDescription, "Request timed out")
    }

    func testCancelledErrorDescription() {
        let error = ClientError.cancelled
        XCTAssertEqual(error.errorDescription, "Request was cancelled")
    }

    // MARK: - Equatable Tests

    func testInvalidURLEquality() {
        XCTAssertEqual(ClientError.invalidURL, ClientError.invalidURL)
    }

    func testInvalidResponseEquality() {
        XCTAssertEqual(ClientError.invalidResponse, ClientError.invalidResponse)
    }

    func testHttpErrorEquality() {
        XCTAssertEqual(ClientError.httpError(statusCode: 404), ClientError.httpError(statusCode: 404))
        XCTAssertNotEqual(ClientError.httpError(statusCode: 404), ClientError.httpError(statusCode: 500))
    }

    func testStreamErrorEquality() {
        XCTAssertEqual(ClientError.streamError("test"), ClientError.streamError("test"))
        XCTAssertNotEqual(ClientError.streamError("test"), ClientError.streamError("other"))
    }

    func testTimeoutEquality() {
        XCTAssertEqual(ClientError.timeout, ClientError.timeout)
    }

    func testCancelledEquality() {
        XCTAssertEqual(ClientError.cancelled, ClientError.cancelled)
    }

    func testDifferentErrorsNotEqual() {
        XCTAssertNotEqual(ClientError.invalidURL, ClientError.invalidResponse)
        XCTAssertNotEqual(ClientError.timeout, ClientError.cancelled)
    }

    // MARK: - Error Throwing Tests

    func testErrorCanBeThrown() {
        XCTAssertThrowsError(try throwingFunction()) { error in
            XCTAssertTrue(error is ClientError)
            if let clientError = error as? ClientError {
                XCTAssertEqual(clientError, ClientError.invalidURL)
            }
        }
    }

    private func throwingFunction() throws {
        throw ClientError.invalidURL
    }
}
