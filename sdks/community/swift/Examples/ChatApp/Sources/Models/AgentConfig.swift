// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIAgentSDK
import Foundation

// MARK: - AgentConfig

struct AgentConfig: Identifiable, Codable, Hashable, Sendable {
    var id: String
    var name: String
    var url: String
    var description: String?
    var systemPrompt: String?
    var authMethod: AuthMethod
    var customHeaders: [HeaderEntry]

    init(
        id: String = UUID().uuidString,
        name: String,
        url: String,
        description: String? = nil,
        systemPrompt: String? = nil,
        authMethod: AuthMethod = .none,
        customHeaders: [HeaderEntry] = []
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.description = description
        self.systemPrompt = systemPrompt
        self.authMethod = authMethod
        self.customHeaders = customHeaders
    }
}

// MARK: - HeaderEntry

struct HeaderEntry: Identifiable, Codable, Hashable, Sendable {
    var id: String
    var key: String
    var value: String

    init(id: String = UUID().uuidString, key: String, value: String) {
        self.id = id
        self.key = key
        self.value = value
    }
}

// MARK: - AuthMethod

enum AuthMethod: Codable, Hashable, Sendable {
    case none
    case apiKey(key: String, headerName: String)
    case bearerToken(String)
    case basicAuth(username: String, password: String)
    case custom(type: String, entries: [HeaderEntry])
}

// MARK: - SDK Bridge

extension AgentConfig {
    /// Builds HTTP headers from the agent's auth method and custom headers.
    func buildHeaders() -> [String: String] {
        var headers: [String: String] = [:]
        for entry in customHeaders {
            let k = entry.key.trimmingCharacters(in: .whitespacesAndNewlines)
            let v = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !k.isEmpty { headers[k] = v }
        }
        switch authMethod {
        case .none:
            break
        case .apiKey(let key, let headerName):
            headers[headerName] = key
        case .bearerToken(let token):
            headers["Authorization"] = "Bearer \(token)"
        case .basicAuth(let username, let password):
            let credential = "\(username):\(password)"
            let encoded = Data(credential.utf8).base64EncodedString()
            headers["Authorization"] = "Basic \(encoded)"
        case .custom(_, let entries):
            for entry in entries {
                let k = entry.key.trimmingCharacters(in: .whitespacesAndNewlines)
                let v = entry.value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !k.isEmpty { headers[k] = v }
            }
        }
        return headers
    }

    /// Converts this config into a `StatefulAgUiAgentConfig`.
    ///
    /// The full URL entered by the user (e.g. `http://localhost:8888/agentic_chat`)
    /// is split into a transport `baseURL` (scheme + host + port) and an `endpoint`
    /// path (e.g. `/agentic_chat`), so the SDK doesn't double-append `/run`.
    ///
    /// - Throws: `AgentConfigError.invalidURL` when the URL string is malformed.
    func toStatefulAgentConfig() throws -> StatefulAgUiAgentConfig {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let agentURL = URL(string: trimmed),
              let scheme = agentURL.scheme,
              let host = agentURL.host else {
            throw AgentConfigError.invalidURL(url)
        }

        // Build a base URL containing only scheme + host + port.
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = agentURL.port
        guard let baseURL = components.url else {
            throw AgentConfigError.invalidURL(url)
        }

        // Use the path as the endpoint; fall back to "/run" if none was given.
        let path = agentURL.path
        let endpoint = path.isEmpty ? "/run" : path

        var config = StatefulAgUiAgentConfig(baseURL: baseURL)
        config.endpoint = endpoint
        config.systemPrompt = systemPrompt
        #if DEBUG
        config.debug = true
        #endif
        config.headers = buildHeaders()
        return config
    }
}

// MARK: - AgentConfigError

enum AgentConfigError: LocalizedError {
    case invalidURL(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url):
            return "Invalid agent URL: \"\(url)\""
        }
    }
}
