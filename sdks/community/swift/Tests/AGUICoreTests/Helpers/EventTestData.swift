// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation
@testable import AGUICore

/// Shared test data constants and factory methods for event tests.
///
/// Provides centralized test data to ensure consistency across all event tests
/// and eliminate magic numbers.
enum EventTestData {

    // MARK: - Standard Test IDs

    /// Standard thread ID for tests
    static let threadId = "thread-123"

    /// Standard run ID for tests
    static let runId = "run-456"

    /// Standard message ID for tests
    static let messageId = "msg-123"

    /// Alternative message ID for tests requiring multiple IDs
    static let messageId2 = "msg-456"

    /// Standard tool call ID for tests
    static let toolCallId = "call-123"

    // MARK: - Standard Timestamps

    /// Standard timestamp for tests (January 1, 2024 00:00:00 UTC).
    ///
    /// Represents 1704067200000 milliseconds since Unix epoch.
    static let timestamp: Int64 = 1704067200000

    /// Alternative timestamp for tests requiring multiple timestamps.
    static let timestamp2: Int64 = 1704067200001
    
    /// Creates a JSON dictionary for event testing
    /// - Parameters:
    ///   - type: The event type string (e.g., "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR")
    ///   - threadId: The thread ID (default: EventTestData.threadId, ignored if additionalFields provided)
    ///   - runId: The run ID (default: EventTestData.runId, ignored if additionalFields provided)
    ///   - timestamp: Optional timestamp
    ///   - additionalFields: Additional fields to include in JSON (overrides threadId/runId if provided)
    /// - Returns: A dictionary representing the event JSON
    static func makeJSON(
        type: String,
        threadId: String = EventTestData.threadId,
        runId: String = EventTestData.runId,
        timestamp: Int64? = nil,
        additionalFields: [String: Any]? = nil
    ) -> [String: Any] {
        var json: [String: Any] = [
            "type": type
        ]
        
        // Use additionalFields if provided, otherwise use threadId/runId
        if let additionalFields = additionalFields {
            json.merge(additionalFields) { _, new in new }
        } else {
            json["threadId"] = threadId
            json["runId"] = runId
        }
        
        if let timestamp = timestamp {
            json["timestamp"] = timestamp
        }
        return json
    }

    /// Creates JSON Data from a dictionary.
    ///
    /// - Parameter dictionary: Dictionary to convert to JSON Data
    /// - Returns: JSON Data representation
    /// - Throws: An error if the dictionary cannot be serialized to JSON
    static func jsonData(from dictionary: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: dictionary, options: [])
    }
}
