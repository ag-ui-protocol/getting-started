// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the FunctionCall type
final class FunctionCallTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithRequiredFields() {
        let functionCall = FunctionCall(
            name: "get_weather",
            arguments: "{\"location\":\"San Francisco\"}"
        )

        XCTAssertEqual(functionCall.name, "get_weather")
        XCTAssertEqual(functionCall.arguments, "{\"location\":\"San Francisco\"}")
    }

    func testInitWithEmptyArguments() {
        let functionCall = FunctionCall(
            name: "no_params_function",
            arguments: "{}"
        )

        XCTAssertEqual(functionCall.name, "no_params_function")
        XCTAssertEqual(functionCall.arguments, "{}")
    }

    func testInitWithComplexArguments() {
        let complexArgs = """
        {
            "user_id": "123",
            "filters": {
                "date_range": ["2024-01-01", "2024-12-31"],
                "categories": ["tech", "science"]
            },
            "limit": 100
        }
        """

        let functionCall = FunctionCall(
            name: "fetch_articles",
            arguments: complexArgs
        )

        XCTAssertEqual(functionCall.name, "fetch_articles")
        XCTAssertTrue(functionCall.arguments.contains("user_id"))
    }

    // MARK: - Encoding Tests

    func testEncodingBasic() throws {
        let functionCall = FunctionCall(
            name: "calculate",
            arguments: "{\"x\":10,\"y\":20}"
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(functionCall)
        let json = String(data: encoded, encoding: .utf8)

        XCTAssertNotNil(json)
        XCTAssertTrue(json?.contains("\"name\"") ?? false)
        XCTAssertTrue(json?.contains("\"arguments\"") ?? false)
        XCTAssertTrue(json?.contains("\"calculate\"") ?? false)
    }

    func testEncodedStructure() throws {
        let functionCall = FunctionCall(
            name: "test_function",
            arguments: "{\"param\":\"value\"}"
        )

        let encoded = try JSONEncoder().encode(functionCall)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertEqual(json?["name"] as? String, "test_function")
        XCTAssertEqual(json?["arguments"] as? String, "{\"param\":\"value\"}")
    }

    // MARK: - Decoding Tests

    func testDecodingBasic() throws {
        let json = """
        {
            "name": "send_email",
            "arguments": "{\\"to\\":\\"user@example.com\\",\\"subject\\":\\"Hello\\"}"
        }
        """

        let decoder = JSONDecoder()
        let functionCall = try decoder.decode(FunctionCall.self, from: Data(json.utf8))

        XCTAssertEqual(functionCall.name, "send_email")
        XCTAssertTrue(functionCall.arguments.contains("user@example.com"))
    }

    func testDecodingWithEmptyArguments() throws {
        let json = """
        {
            "name": "ping",
            "arguments": "{}"
        }
        """

        let decoder = JSONDecoder()
        let functionCall = try decoder.decode(FunctionCall.self, from: Data(json.utf8))

        XCTAssertEqual(functionCall.name, "ping")
        XCTAssertEqual(functionCall.arguments, "{}")
    }

    func testDecodingFailsWithoutName() {
        let json = """
        {
            "arguments": "{}"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(FunctionCall.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func testDecodingFailsWithoutArguments() {
        let json = """
        {
            "name": "test"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(FunctionCall.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    // MARK: - Round-trip Tests

    func testRoundTrip() throws {
        let original = FunctionCall(
            name: "get_user_info",
            arguments: "{\"user_id\":\"abc123\",\"include_profile\":true}"
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(FunctionCall.self, from: encoded)

        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.arguments, original.arguments)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let call1 = FunctionCall(name: "func", arguments: "{\"x\":1}")
        let call2 = FunctionCall(name: "func", arguments: "{\"x\":1}")
        let call3 = FunctionCall(name: "other", arguments: "{\"x\":1}")
        let call4 = FunctionCall(name: "func", arguments: "{\"x\":2}")

        XCTAssertEqual(call1, call2)
        XCTAssertNotEqual(call1, call3)
        XCTAssertNotEqual(call1, call4)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let call1 = FunctionCall(name: "func1", arguments: "{}")
        let call2 = FunctionCall(name: "func2", arguments: "{}")

        let set: Set<FunctionCall> = [call1, call2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(call1))
        XCTAssertTrue(set.contains(call2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let functionCall = FunctionCall(name: "test", arguments: "{}")

        Task {
            let capturedCall = functionCall
            XCTAssertEqual(capturedCall.name, "test")
        }
    }

    // MARK: - Arguments Parsing Tests

    func testArgumentsAsValidJSON() throws {
        let functionCall = FunctionCall(
            name: "test",
            arguments: "{\"key\":\"value\",\"number\":42}"
        )

        // Verify arguments can be parsed as JSON
        let argsData = Data(functionCall.arguments.utf8)
        let parsed = try JSONSerialization.jsonObject(with: argsData) as? [String: Any]

        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["key"] as? String, "value")
        XCTAssertEqual(parsed?["number"] as? Int, 42)
    }

    func testDecodableArgumentsStruct() throws {
        struct WeatherArgs: Codable {
            let location: String
            let units: String
        }

        let functionCall = FunctionCall(
            name: "get_weather",
            arguments: "{\"location\":\"Paris\",\"units\":\"celsius\"}"
        )

        // Verify arguments can be decoded into a struct
        let argsData = Data(functionCall.arguments.utf8)
        let weatherArgs = try JSONDecoder().decode(WeatherArgs.self, from: argsData)

        XCTAssertEqual(weatherArgs.location, "Paris")
        XCTAssertEqual(weatherArgs.units, "celsius")
    }

    // MARK: - Real-world Usage Tests

    func testWeatherFunctionCall() {
        let weatherCall = FunctionCall(
            name: "get_current_weather",
            arguments: """
            {
                "location": "Boston, MA",
                "unit": "fahrenheit"
            }
            """
        )

        XCTAssertEqual(weatherCall.name, "get_current_weather")
        XCTAssertTrue(weatherCall.arguments.contains("Boston"))
    }

    func testDatabaseQueryFunctionCall() {
        let queryCall = FunctionCall(
            name: "execute_sql_query",
            arguments: """
            {
                "database": "users_db",
                "query": "SELECT * FROM users WHERE active = true",
                "max_results": 100
            }
            """
        )

        XCTAssertEqual(queryCall.name, "execute_sql_query")
        XCTAssertTrue(queryCall.arguments.contains("users_db"))
    }

    func testAPIRequestFunctionCall() {
        let apiCall = FunctionCall(
            name: "http_request",
            arguments: """
            {
                "method": "POST",
                "url": "https://api.example.com/v1/data",
                "headers": {
                    "Authorization": "Bearer token123"
                },
                "body": {
                    "data": "example"
                }
            }
            """
        )

        XCTAssertEqual(apiCall.name, "http_request")
        XCTAssertTrue(apiCall.arguments.contains("POST"))
    }

    func testNoArgumentsFunction() {
        let noArgsCall = FunctionCall(
            name: "get_current_time",
            arguments: "{}"
        )

        XCTAssertEqual(noArgsCall.name, "get_current_time")
        XCTAssertEqual(noArgsCall.arguments, "{}")
    }
}
