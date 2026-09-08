// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import AGUITools

// MARK: - Shared mock ToolRegistry for AGUIAgentSDK tests

actor MockToolRegistry: ToolRegistry {
    private let tools: [Tool]

    init(tools: [Tool] = []) {
        self.tools = tools
    }

    func allTools() async -> [Tool] { tools }
    func register(executor: any ToolExecutor) async throws {}
    func unregister(toolName: String) async -> Bool { false }
    func executor(for toolName: String) async -> (any ToolExecutor)? { nil }
    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(success: false, message: "mock")
    }
    func isToolRegistered(toolName: String) async -> Bool { false }
    func stats(for toolName: String) async -> ToolExecutionStats? { nil }
    func getAllStats() async -> [String: ToolExecutionStats] { [:] }
    func clearStats() async {}
    func getAllExecutors() async -> [String: any ToolExecutor] { [:] }
}
