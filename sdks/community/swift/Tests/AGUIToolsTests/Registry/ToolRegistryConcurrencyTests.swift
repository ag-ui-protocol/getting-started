// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
import AGUICore
@testable import AGUITools

final class ToolRegistryConcurrencyTests: XCTestCase {

    // MARK: - Concurrent Registration Tests

    func testConcurrentRegistration() async throws {
        // Given: A registry and multiple tools
        let registry = DefaultToolRegistry()
        let toolCount = 10

        // When: Registering multiple tools concurrently
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<toolCount {
                group.addTask {
                    let tool = Tool(
                        name: "concurrent_tool_\(i)",
                        description: "Tool \(i)",
                        parameters: Data("{}".utf8)
                    )
                    let executor = TestToolExecutor(tool: tool)
                    try await registry.register(executor: executor)
                }
            }
            try await group.waitForAll()
        }

        // Then: All tools should be registered
        let allTools = await registry.allTools()
        XCTAssertEqual(allTools.count, toolCount)
    }

    func testConcurrentUnregistration() async throws {
        // Given: A registry with multiple registered tools
        let registry = DefaultToolRegistry()
        let toolCount = 10

        for i in 0..<toolCount {
            let tool = Tool(
                name: "unregister_tool_\(i)",
                description: "Tool \(i)",
                parameters: Data("{}".utf8)
            )
            try await registry.register(executor: TestToolExecutor(tool: tool))
        }

        // When: Unregistering tools concurrently
        await withTaskGroup(of: Bool.self) { group in
            for i in 0..<toolCount {
                group.addTask {
                    await registry.unregister(toolName: "unregister_tool_\(i)")
                }
            }
        }

        // Then: All tools should be unregistered
        let allTools = await registry.allTools()
        XCTAssertEqual(allTools.count, 0)
    }

    // MARK: - Concurrent Execution Tests

    func testConcurrentExecution() async throws {
        // Given: A registry with a registered tool
        let registry = DefaultToolRegistry()
        let tool = Tool(
            name: "concurrent_exec",
            description: "Concurrent execution test",
            parameters: Data("{}".utf8)
        )
        let executor = TestToolExecutor(tool: tool)
        try await registry.register(executor: executor)

        let executionCount = 20

        // When: Executing the tool concurrently from multiple tasks
        try await withThrowingTaskGroup(of: ToolExecutionResult.self) { group in
            for i in 0..<executionCount {
                group.addTask {
                    let toolCall = ToolCall(
                        id: "concurrent_call_\(i)",
                        function: FunctionCall(name: "concurrent_exec", arguments: "{}")
                    )
                    let context = ToolExecutionContext(toolCall: toolCall)
                    return try await registry.execute(context: context)
                }
            }

            var successCount = 0
            for try await result in group where result.success {
                successCount += 1
            }

            XCTAssertEqual(successCount, executionCount)
        }

        // Then: Stats should reflect all executions
        let stats = await registry.stats(for: "concurrent_exec")
        XCTAssertEqual(stats?.executionCount, executionCount)
        XCTAssertEqual(stats?.successCount, executionCount)
    }

    func testConcurrentExecutionMultipleTools() async throws {
        // Given: A registry with multiple tools
        let registry = DefaultToolRegistry()
        let toolCount = 5
        let executionsPerTool = 10

        for i in 0..<toolCount {
            let tool = Tool(
                name: "multi_tool_\(i)",
                description: "Tool \(i)",
                parameters: Data("{}".utf8)
            )
            try await registry.register(executor: TestToolExecutor(tool: tool))
        }

        // When: Executing multiple tools concurrently
        try await withThrowingTaskGroup(of: Void.self) { group in
            for toolIdx in 0..<toolCount {
                for execIdx in 0..<executionsPerTool {
                    group.addTask {
                        let toolCall = ToolCall(
                            id: "call_\(toolIdx)_\(execIdx)",
                            function: FunctionCall(name: "multi_tool_\(toolIdx)", arguments: "{}")
                        )
                        let context = ToolExecutionContext(toolCall: toolCall)
                        _ = try await registry.execute(context: context)
                    }
                }
            }
            try await group.waitForAll()
        }

        // Then: All tools should have correct execution counts
        for i in 0..<toolCount {
            let stats = await registry.stats(for: "multi_tool_\(i)")
            XCTAssertEqual(stats?.executionCount, executionsPerTool)
        }
    }

    // MARK: - Mixed Operations Tests

    func testConcurrentMixedOperations() async throws {
        // Given: A registry
        let registry = DefaultToolRegistry()

        // When: Performing mixed operations concurrently
        try await withThrowingTaskGroup(of: Void.self) { group in
            // Register tools
            for i in 0..<10 {
                group.addTask {
                    let tool = Tool(
                        name: "mixed_tool_\(i)",
                        description: "Tool \(i)",
                        parameters: Data("{}".utf8)
                    )
                    try await registry.register(executor: TestToolExecutor(tool: tool))
                }
            }

            // Execute tools
            for i in 0..<10 {
                group.addTask {
                    // Small delay to let some tools register
                    try await Task.sleep(for: .milliseconds(10))
                    let toolCall = ToolCall(
                        id: "mixed_call_\(i)",
                        function: FunctionCall(name: "mixed_tool_\(i)", arguments: "{}")
                    )
                    let context = ToolExecutionContext(toolCall: toolCall)
                    _ = try? await registry.execute(context: context)
                }
            }

            // Query tools
            group.addTask {
                for _ in 0..<20 {
                    _ = await registry.allTools()
                    try await Task.sleep(for: .milliseconds(5))
                }
            }

            // Check stats
            group.addTask {
                for i in 0..<20 {
                    _ = await registry.stats(for: "mixed_tool_\(i % 10)")
                    try await Task.sleep(for: .milliseconds(5))
                }
            }

            try await group.waitForAll()
        }

        // Then: Registry should be in consistent state
        let allTools = await registry.allTools()
        XCTAssertEqual(allTools.count, 10)
    }

    // MARK: - Race Condition Tests

    func testNoRaceConditionInStatsUpdate() async throws {
        // Given: A registry with a tool
        let registry = DefaultToolRegistry()
        let tool = Tool(
            name: "race_test",
            description: "Race condition test",
            parameters: Data("{}".utf8)
        )
        try await registry.register(executor: TestToolExecutor(tool: tool))

        let iterations = 50

        // When: Executing concurrently
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<iterations {
                group.addTask {
                    let toolCall = ToolCall(
                        id: "race_call_\(i)",
                        function: FunctionCall(name: "race_test", arguments: "{}")
                    )
                    let context = ToolExecutionContext(toolCall: toolCall)
                    _ = try await registry.execute(context: context)
                }
            }
            try await group.waitForAll()
        }

        // Then: Stats should be accurate (no lost updates)
        let stats = await registry.stats(for: "race_test")
        XCTAssertEqual(stats?.executionCount, iterations)
        XCTAssertEqual(stats?.successCount, iterations)
        XCTAssertEqual(stats?.failureCount, 0)
    }

    func testConcurrentStatsQueries() async throws {
        // Given: A registry with tools and some execution history
        let registry = DefaultToolRegistry()
        let tool = Tool(
            name: "stats_query_test",
            description: "Test",
            parameters: Data("{}".utf8)
        )
        try await registry.register(executor: TestToolExecutor(tool: tool))

        // Execute once to create stats
        let toolCall = ToolCall(
            id: "initial_call",
            function: FunctionCall(name: "stats_query_test", arguments: "{}")
        )
        _ = try await registry.execute(context: ToolExecutionContext(toolCall: toolCall))

        // When: Querying stats concurrently
        await withTaskGroup(of: ToolExecutionStats?.self) { group in
            for _ in 0..<100 {
                group.addTask {
                    await registry.stats(for: "stats_query_test")
                }
            }

            var allStats: [ToolExecutionStats] = []
            for await stats in group {
                if let stats = stats {
                    allStats.append(stats)
                }
            }

            // Then: All stats should be consistent
            let uniqueStats = Set(allStats)
            XCTAssertEqual(uniqueStats.count, 1) // All should return the same stats
        }
    }

    // MARK: - Stress Tests

    func testHighConcurrencyLoad() async throws {
        // Given: A registry with multiple tools
        let registry = DefaultToolRegistry()
        let toolCount = 5

        for i in 0..<toolCount {
            let tool = Tool(
                name: "stress_tool_\(i)",
                description: "Tool \(i)",
                parameters: Data("{}".utf8)
            )
            try await registry.register(executor: TestToolExecutor(tool: tool))
        }

        let tasksPerTool = 20

        // When: Creating high concurrent load
        try await withThrowingTaskGroup(of: Void.self) { group in
            for toolIdx in 0..<toolCount {
                for taskIdx in 0..<tasksPerTool {
                    group.addTask {
                        let toolCall = ToolCall(
                            id: "stress_call_\(toolIdx)_\(taskIdx)",
                            function: FunctionCall(name: "stress_tool_\(toolIdx)", arguments: "{}")
                        )
                        let context = ToolExecutionContext(toolCall: toolCall)
                        _ = try await registry.execute(context: context)
                    }
                }
            }
            try await group.waitForAll()
        }

        // Then: All executions should complete successfully
        let totalExpected = toolCount * tasksPerTool
        var totalExecuted = 0

        for i in 0..<toolCount {
            if let stats = await registry.stats(for: "stress_tool_\(i)") {
                totalExecuted += stats.executionCount
            }
        }

        XCTAssertEqual(totalExecuted, totalExpected)
    }

    // MARK: - Actor Isolation Tests

    func testActorIsolationPreservesConsistency() async throws {
        // Given: Multiple actors sharing a registry
        let registry = DefaultToolRegistry()
        let tool = Tool(
            name: "actor_test",
            description: "Actor isolation test",
            parameters: Data("{}".utf8)
        )
        try await registry.register(executor: TestToolExecutor(tool: tool))

        actor Counter {
            var value: Int = 0

            func increment() {
                value += 1
            }

            func getValue() -> Int {
                value
            }
        }

        let counter = Counter()
        let iterations = 30

        // When: Multiple actors execute tools
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<iterations {
                group.addTask {
                    let toolCall = ToolCall(
                        id: "actor_call_\(i)",
                        function: FunctionCall(name: "actor_test", arguments: "{}")
                    )
                    let context = ToolExecutionContext(toolCall: toolCall)
                    _ = try await registry.execute(context: context)
                    await counter.increment()
                }
            }
            try await group.waitForAll()
        }

        // Then: Counter and stats should match
        let counterValue = await counter.getValue()
        let stats = await registry.stats(for: "actor_test")
        XCTAssertEqual(counterValue, iterations)
        XCTAssertEqual(stats?.executionCount, iterations)
    }
}

// MARK: - Helper Types

// TestToolExecutor is defined in ToolRegistryTests.swift and shared across test files
