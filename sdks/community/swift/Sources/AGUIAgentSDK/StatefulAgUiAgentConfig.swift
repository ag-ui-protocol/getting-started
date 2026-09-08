// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import Foundation

/// Configuration for ``StatefulAgUiAgent``.
///
/// This struct provides all configuration options for creating a stateful agent,
/// including HTTP settings, conversation management, and agent behavior.
///
/// ## Example
///
/// ```swift
/// var config = StatefulAgUiAgentConfig(baseURL: agentURL)
/// config.systemPrompt = "You are a helpful AI assistant."
/// config.maxHistoryLength = 50
/// config.timeout = .seconds(60)
/// config.headers = ["Authorization": "Bearer token"]
///
/// let agent = StatefulAgUiAgent(configuration: config)
/// ```
public struct StatefulAgUiAgentConfig: Sendable {
    /// The base URL of the AG-UI agent server.
    public var baseURL: URL

    /// Initial state for the agent.
    ///
    /// This JSON-encoded state is sent with the first run and updated
    /// automatically based on state events from the agent.
    public var initialState: State

    /// Maximum number of messages to keep in conversation history.
    ///
    /// When the history exceeds this limit, older messages are trimmed
    /// while preserving the system message. Set to `0` for unlimited history.
    ///
    /// Default: `100`
    public var maxHistoryLength: Int

    /// System prompt automatically added to new conversations.
    ///
    /// When set, this message is added as the first message in a new thread's
    /// conversation history. It provides the agent with behavioral instructions.
    ///
    /// Default: `nil`
    public var systemPrompt: String?

    /// Request timeout in seconds.
    ///
    /// Maximum time to wait for the agent server to respond before timing out.
    ///
    /// Default: `120.0`
    public var timeout: TimeInterval

    /// Custom HTTP headers to include in requests.
    ///
    /// Common headers include:
    /// - Authorization: Bearer tokens or API keys
    /// - Custom tracking or correlation IDs
    ///
    /// Default: `[:]`
    public var headers: [String: String]

    /// Optional tool registry.
    ///
    /// When set, tool definitions are automatically included in every
    /// `RunAgentInput` and tool calls from the agent are executed automatically.
    ///
    /// Default: `nil`
    public var toolRegistry: (any ToolRegistry)?

    /// Persistent user ID for message attribution.
    ///
    /// Default: `nil`
    public var userId: String?

    /// Context items included with every request.
    ///
    /// Default: `[]`
    public var context: [Context]

    /// Bearer token for authentication.
    ///
    /// When set, ``buildHeaders()`` includes `Authorization: Bearer <token>`.
    /// This property does **not** mutate ``headers`` directly — use
    /// ``buildHeaders()`` to get the merged dictionary for request construction.
    ///
    /// Default: `nil`
    public var bearerToken: String?

    /// API key value.
    ///
    /// Used together with ``apiKeyHeader`` to add an API key header to requests.
    ///
    /// Default: `nil`
    public var apiKey: String?

    /// Header name for the API key.
    ///
    /// Default: `"X-API-Key"`
    public var apiKeyHeader: String

    /// When `true`, enables verbose pipeline logging.
    ///
    /// Default: `false`
    public var debug: Bool

    /// The endpoint path appended to `baseURL` for each run request.
    ///
    /// Override this when the agent server exposes its AG-UI endpoint at a
    /// non-standard path. For example, the Claude Agent SDK demo server uses
    /// `/agentic_chat` instead of the default `/run`.
    ///
    /// Default: `"/run"`
    public var endpoint: String

    // MARK: - Header builder

    /// Returns the final HTTP header dictionary, merging ``bearerToken`` and
    /// ``apiKey`` into ``headers``.
    ///
    /// Priority (highest → lowest):
    /// 1. Entries already in ``headers``
    /// 2. `bearerToken` → `Authorization: Bearer <token>`
    /// 3. `apiKey` → `<apiKeyHeader>: <key>`
    ///
    /// - Returns: Merged header dictionary ready for `HttpAgentConfiguration`.
    public func buildHeaders() -> [String: String] {
        AgentHeaderBuilder.buildHeaders(
            headers: headers,
            bearerToken: bearerToken,
            apiKey: apiKey,
            apiKeyHeader: apiKeyHeader
        )
    }

    /// Creates a new stateful agent configuration.
    ///
    /// - Parameter baseURL: The base URL of the AG-UI agent server
    public init(baseURL: URL) {
        self.baseURL = baseURL
        self.initialState = Data("{}".utf8)
        self.maxHistoryLength = 100
        self.systemPrompt = nil
        self.timeout = 120.0
        self.headers = [:]
        self.toolRegistry = nil
        self.userId = nil
        self.context = []
        self.bearerToken = nil
        self.apiKey = nil
        self.apiKeyHeader = "X-API-Key"
        self.debug = false
        self.endpoint = "/run"
    }
}
