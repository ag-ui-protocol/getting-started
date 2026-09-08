// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import AGUITools
import Foundation

public final class AgUiAgent: Sendable {

    // MARK: - Public properties

    public let config: AgUiAgentConfig

    // MARK: - Private state

    // Non-nil for URL-based init; provides run/subscribe/dispose and tool responses.
    // The HttpAgent owns the single URLSession for this init path.
    private let httpAgent: HttpAgent?
    // Non-nil for transport-based init; provides run/subscribe/dispose without
    // needing an HttpAgent (avoids the placeholder-URL dummy agent).
    private let abstractAgent: AbstractAgent?
    private let toolExecutionManager: ToolExecutionManager?

    /// Stable thread ID used when the caller does not provide one.
    /// Generated once at init time so consecutive `sendMessage` calls share a conversation thread.
    private let defaultThreadId: String = UUID().uuidString

    // MARK: - Initialization

    public init(
        url: URL,
        configure: (inout AgUiAgentConfig) -> Void = { _ in }
    ) {
        var cfg = AgUiAgentConfig()
        configure(&cfg)
        self.config = cfg

        var httpConfig = HttpAgentConfiguration(baseURL: url)
        httpConfig.timeout = cfg.requestTimeout
        httpConfig.retryPolicy = cfg.retryPolicy
        httpConfig.headers = cfg.buildHeaders()

        let agent = HttpAgent(configuration: httpConfig)
        self.httpAgent = agent
        self.abstractAgent = nil

        if let registry = cfg.toolRegistry {
            self.toolExecutionManager = ToolExecutionManager(
                toolRegistry: registry,
                responseHandler: ClientToolResponseHandler(httpAgent: agent)
            )
        } else {
            self.toolExecutionManager = nil
        }
    }

    public init(
        transport: any AgentTransport,
        config: AgUiAgentConfig = AgUiAgentConfig(),
        toolExecutionManager: ToolExecutionManager? = nil
    ) {
        self.config = config
        self.httpAgent = nil
        self.abstractAgent = AbstractAgent(transport: transport)
        self.toolExecutionManager = toolExecutionManager
    }

    // MARK: - Core run method

    public func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        if let agent = httpAgent { return agent.run(input: input) }
        return abstractAgent!.run(input: input)
    }

    // MARK: - sendMessage (primary API)

    public func sendMessage(
        _ message: String,
        threadId: String? = nil,
        state: State? = nil,
        includeSystemPrompt: Bool = true
    ) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let effectiveThreadId = threadId ?? self.defaultThreadId

                    var messages: [any Message] = []

                    if includeSystemPrompt, let prompt = self.config.systemPrompt {
                        messages.append(SystemMessage(
                            id: "sys_\(UUID().uuidString)",
                            content: prompt
                        ))
                    }

                    messages.append(UserMessage(
                        id: "usr_\(UUID().uuidString)",
                        content: message
                    ))

                    var tools: [Tool] = []
                    if let registry = self.config.toolRegistry {
                        tools = await registry.allTools()
                    }

                    let input = RunAgentInput(
                        threadId: effectiveThreadId,
                        runId: "run_\(UUID().uuidString)",
                        state: state ?? Data("{}".utf8),
                        messages: messages,
                        tools: tools,
                        context: self.config.context,
                        forwardedProps: self.config.forwardedProps
                    )

                    let rawStream = self.run(input: input)

                    if let manager = self.toolExecutionManager {
                        let managed = await manager.processEventStream(
                            rawStream,
                            threadId: input.threadId,
                            runId: input.runId
                        )
                        for try await event in managed {
                            continuation.yield(event)
                        }
                    } else {
                        for try await event in rawStream {
                            continuation.yield(event)
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Subscriber

    public func subscribe(_ subscriber: any AgentSubscriber) async -> any AgentSubscription {
        if let agent = httpAgent { return await agent.subscribe(subscriber) }
        return await abstractAgent!.subscribe(subscriber)
    }

    // MARK: - Lifecycle

    public func close() async {
        if let manager = toolExecutionManager {
            await manager.cancelAllExecutions()
        }
        if let agent = httpAgent {
            await agent.dispose()
        } else {
            await abstractAgent!.dispose()
        }
    }
}
