// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct RunFinishedEventDTO {
    let threadId: String
    let runId: String
    let outcome: RunFinishedOutcome?
    let result: Data?
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> RunFinishedEventDTO {
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        let threadId: String
        if let raw = jsonObject["threadId"] {
            guard let value = raw as? String else {
                throw DecodingError.typeMismatch(
                    String.self,
                    DecodingError.Context(codingPath: [CodingKeys.threadId], debugDescription: "Type mismatch for 'threadId': expected String")
                )
            }
            threadId = value
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.threadId,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: threadId")
            )
        }

        let runId: String
        if let raw = jsonObject["runId"] {
            guard let value = raw as? String else {
                throw DecodingError.typeMismatch(
                    String.self,
                    DecodingError.Context(codingPath: [CodingKeys.runId], debugDescription: "Type mismatch for 'runId': expected String")
                )
            }
            runId = value
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.runId,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: runId")
            )
        }

        // The AG-UI wire protocol sends `outcome` as a discriminated union object:
        //   { "type": "success" }
        //   { "type": "interrupt", "interrupts": [ { "id": "...", "reason": "..." }, ... ] }
        //
        // A null or missing field means no outcome was provided (legacy producer).
        // An unrecognised "type" value is treated as nil for forward compatibility.
        let outcome: RunFinishedOutcome? = try decodeOutcome(from: jsonObject)

        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        var resultData: Data?
        if let resultValue = jsonObject["result"], !(resultValue is NSNull) {
            resultData = try? JSONSerialization.data(withJSONObject: resultValue)
        }

        return RunFinishedEventDTO(threadId: threadId, runId: runId, outcome: outcome, result: resultData, timestamp: timestamp)
    }

    func toDomain(rawEvent: Data? = nil) -> RunFinishedEvent {
        RunFinishedEvent(threadId: threadId, runId: runId, outcome: outcome, result: result, timestamp: timestamp, rawEvent: rawEvent)
    }

    // MARK: - Private

    private static func decodeOutcome(from jsonObject: [String: Any]) throws -> RunFinishedOutcome? {
        guard let outcomeValue = jsonObject["outcome"],
              !(outcomeValue is NSNull),
              let outcomeObj = outcomeValue as? [String: Any],
              let type = outcomeObj["type"] as? String
        else {
            return nil
        }

        switch type {
        case "success":
            return .success

        case "interrupt":
            let rawInterrupts = outcomeObj["interrupts"] as? [[String: Any]] ?? []
            let interrupts = try rawInterrupts.map { try Interrupt.decode(from: $0) }
            // The TypeScript schema requires at least one interrupt for this outcome type.
            // An empty array is treated as nil (malformed payload) for safety.
            guard !interrupts.isEmpty else { return nil }
            return .interrupt(interrupts)

        default:
            // Forward-compatible: unknown future outcome types are treated as nil.
            return nil
        }
    }

    private enum CodingKeys: String, CodingKey {
        case threadId, runId, outcome, result, timestamp
    }
}
