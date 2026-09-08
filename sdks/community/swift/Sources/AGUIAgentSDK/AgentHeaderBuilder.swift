// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Shared header-building logic for agent configuration types.
///
/// Both `AgUiAgentConfig` and `StatefulAgUiAgentConfig` need identical logic to
/// merge bearer-token / API-key auth helpers into an explicit headers dictionary
/// while stripping CRLF characters to prevent header injection.
///
/// This is an internal implementation detail — only the config types delegate here.
enum AgentHeaderBuilder {

    /// Builds the final HTTP header dictionary by merging auth helpers into `headers`.
    ///
    /// Priority (highest → lowest):
    /// 1. Entries already in `headers`
    /// 2. `bearerToken` → `Authorization: Bearer <token>`
    /// 3. `apiKey` → `<apiKeyHeader>: <key>`
    ///
    /// - Parameters:
    ///   - headers: Base header dictionary (highest priority)
    ///   - bearerToken: Optional bearer token
    ///   - apiKey: Optional API key value
    ///   - apiKeyHeader: Header name for the API key (default `"X-API-Key"`)
    /// - Returns: Merged header dictionary ready for `HttpAgentConfiguration`.
    static func buildHeaders(
        headers: [String: String],
        bearerToken: String?,
        apiKey: String?,
        apiKeyHeader: String
    ) -> [String: String] {
        var result: [String: String] = [:]

        // Low-priority auth headers first
        if let key = apiKey {
            result[apiKeyHeader] = sanitize(key)
        }
        if let token = bearerToken {
            result["Authorization"] = "Bearer \(sanitize(token))"
        }

        // User-supplied headers override auth helpers
        for (k, v) in headers {
            result[k] = sanitize(v)
        }

        return result
    }

    /// Strips CR and LF from a header value to prevent CRLF injection.
    static func sanitize(_ value: String) -> String {
        value.replacingOccurrences(of: "\r", with: "")
             .replacingOccurrences(of: "\n", with: "")
    }
}
