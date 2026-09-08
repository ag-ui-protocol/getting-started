// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - AgentDraft

/// Mutable form state for creating or editing an `AgentConfig`.
struct AgentDraft: Sendable {
    var name: String = ""
    var url: String = ""
    var description: String = ""
    var systemPrompt: String = ""
    var customHeaders: [HeaderField] = []
    var authSelection: AuthMethodSelection = .none

    // API Key
    var apiKey: String = ""
    var apiHeaderName: String = "X-API-Key"

    // Bearer token
    var bearerToken: String = ""

    // Basic auth
    var basicUsername: String = ""
    var basicPassword: String = ""

    // Custom auth
    var customAuthType: String = ""
    var customConfiguration: [HeaderField] = []

    init() {}

    init(from config: AgentConfig) {
        name = config.name
        url = config.url
        description = config.description ?? ""
        systemPrompt = config.systemPrompt ?? ""
        customHeaders = config.customHeaders.map { HeaderField(key: $0.key, value: $0.value) }

        switch config.authMethod {
        case .none:
            authSelection = .none
        case .apiKey(let key, let headerName):
            authSelection = .apiKey
            apiKey = key
            apiHeaderName = headerName
        case .bearerToken(let token):
            authSelection = .bearerToken
            bearerToken = token
        case .basicAuth(let username, let password):
            authSelection = .basicAuth
            basicUsername = username
            basicPassword = password
        case .custom(let type, let entries):
            authSelection = .custom
            customAuthType = type
            customConfiguration = entries.map { HeaderField(key: $0.key, value: $0.value) }
        }
    }

    func toAgentConfig(existingId: String? = nil) -> AgentConfig {
        let authMethod: AuthMethod
        switch authSelection {
        case .none:
            authMethod = .none
        case .apiKey:
            authMethod = .apiKey(key: apiKey, headerName: apiHeaderName)
        case .bearerToken:
            authMethod = .bearerToken(bearerToken)
        case .basicAuth:
            authMethod = .basicAuth(username: basicUsername, password: basicPassword)
        case .custom:
            authMethod = .custom(
                type: customAuthType,
                entries: customConfiguration.compactMap { $0.toHeaderEntry() }
            )
        }
        return AgentConfig(
            id: existingId ?? UUID().uuidString,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            url: url.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description,
            systemPrompt: systemPrompt.isEmpty ? nil : systemPrompt,
            authMethod: authMethod,
            customHeaders: customHeaders.compactMap { $0.toHeaderEntry() }
        )
    }

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - AuthMethodSelection

enum AuthMethodSelection: String, CaseIterable, Identifiable, Sendable {
    case none, apiKey, bearerToken, basicAuth, custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none: return "None"
        case .apiKey: return "API Key"
        case .bearerToken: return "Bearer Token"
        case .basicAuth: return "Basic Auth"
        case .custom: return "Custom"
        }
    }
}

// MARK: - HeaderField

/// Mutable key-value pair used in form editors.
struct HeaderField: Identifiable, Hashable, Sendable {
    // Use a stable id so ForEach($items) bindings work across reorders.
    let id: UUID = UUID()
    var key: String = ""
    var value: String = ""

    init(key: String = "", value: String = "") {
        self.key = key
        self.value = value
    }

    func toHeaderEntry() -> HeaderEntry? {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty, !v.isEmpty else { return nil }
        return HeaderEntry(key: k, value: v)
    }
}

// MARK: - AgentFormMode

enum AgentFormMode: Equatable, Sendable {
    case create
    case edit(AgentConfig)

    static func == (lhs: AgentFormMode, rhs: AgentFormMode) -> Bool {
        switch (lhs, rhs) {
        case (.create, .create): return true
        case let (.edit(l), .edit(r)): return l.id == r.id
        default: return false
        }
    }
}
