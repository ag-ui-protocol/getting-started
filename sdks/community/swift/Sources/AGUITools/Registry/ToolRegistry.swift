// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

/// Protocol for managing tool executors.
///
/// A tool registry provides a centralized location for:
/// - Registering and discovering tool executors
/// - Executing tool calls with automatic executor lookup
/// - Tracking execution statistics
/// - Managing tool lifecycle
///
/// ## Usage
///
/// ```swift
/// // Create and configure a registry
/// let registry = DefaultToolRegistry()
///
/// // Register tools
/// try await registry.register(executor: MyToolExecutor())
///
/// // Execute a tool call
/// let result = try await registry.execute(context: context)
///
/// // Query statistics
/// if let stats = await registry.stats(for: "my_tool") {
///     print("Success rate: \(stats.successRate)")
/// }
/// ```
///
/// ## Thread Safety
///
/// All ToolRegistry implementations must be thread-safe and support
/// concurrent access from multiple tasks/actors.
///
/// - SeeAlso: ``DefaultToolRegistry``, ``ToolExecutor``, ``ToolExecutionStats``
public protocol ToolRegistry: Sendable {
    /// Registers a tool executor.
    ///
    /// - Parameter executor: The tool executor to register
    /// - Throws: ``ToolRegistryError/alreadyRegistered(_:)`` if a tool with the same name exists
    /// - Throws: ``ToolRegistryError/emptyToolName`` if the tool name is empty
    func register(executor: any ToolExecutor) async throws

    /// Unregisters a tool executor by name.
    ///
    /// - Parameter toolName: The name of the tool to unregister
    /// - Returns: `true` if the tool was unregistered, `false` if not found
    func unregister(toolName: String) async -> Bool

    /// Gets a tool executor by name.
    ///
    /// - Parameter toolName: The name of the tool
    /// - Returns: The tool executor, or `nil` if not found
    func executor(for toolName: String) async -> (any ToolExecutor)?

    /// Gets all registered tool definitions.
    ///
    /// Used by clients to populate the tools array in RunAgentInput.
    ///
    /// - Returns: List of all registered tools
    func allTools() async -> [Tool]

    /// Checks if a tool is registered.
    ///
    /// - Parameter toolName: The name of the tool
    /// - Returns: `true` if the tool is registered
    func isToolRegistered(toolName: String) async -> Bool

    /// Executes a tool call.
    ///
    /// This method:
    /// 1. Looks up the executor for the tool
    /// 2. Executes the tool with timeout handling
    /// 3. Updates execution statistics
    ///
    /// - Parameter context: The execution context
    /// - Returns: The execution result
    /// - Throws: ``ToolRegistryError/toolNotFound(_:)`` if tool not registered
    /// - Throws: ``ToolExecutionError`` if execution fails
    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult

    /// Gets execution statistics for a specific tool.
    ///
    /// - Parameter toolName: The name of the tool
    /// - Returns: Execution statistics, or `nil` if tool not found
    func stats(for toolName: String) async -> ToolExecutionStats?

    /// Gets execution statistics for all tools.
    ///
    /// - Returns: Map of tool name to execution statistics
    func getAllStats() async -> [String: ToolExecutionStats]

    /// Clears execution statistics for all tools.
    func clearStats() async

    /// Gets all registered tool executors.
    ///
    /// Returns a snapshot of the current executor map, keyed by tool name.
    ///
    /// - Returns: Map of tool name to executor
    func getAllExecutors() async -> [String: any ToolExecutor]
}

// MARK: - ToolRegistryError

/// Errors that can occur during tool registry operations.
public enum ToolRegistryError: Error, Sendable {
    /// A tool with the given name is already registered.
    case alreadyRegistered(String)

    /// Cannot register a tool with an empty name.
    case emptyToolName

    /// The requested tool was not found in the registry.
    case toolNotFound(String)
}

// MARK: - DefaultToolRegistry

/// Default implementation of ToolRegistry using actor isolation.
///
/// `DefaultToolRegistry` provides a thread-safe tool registry that:
/// - Uses actor isolation for automatic synchronization
/// - Tracks execution statistics for monitoring
/// - Supports timeout handling based on tool configuration
/// - Handles errors gracefully with statistics updates
///
/// ## Usage
///
/// ```swift
/// // Create a registry
/// let registry = DefaultToolRegistry()
///
/// // Register tools
/// try await registry.register(executor: WeatherToolExecutor())
/// try await registry.register(executor: CalculatorToolExecutor())
///
/// // Execute tool calls from agent
/// for toolCall in agentToolCalls {
///     let context = ToolExecutionContext(toolCall: toolCall)
///     let result = try await registry.execute(context: context)
///     // Send result back to agent
/// }
/// ```
///
/// ## Thread Safety
///
/// This actor-based implementation provides automatic thread safety through
/// Swift's actor isolation. All mutable state is protected by the actor.
///
/// - SeeAlso: ``ToolRegistry``, ``ToolExecutor``
public actor DefaultToolRegistry: ToolRegistry {
    private var executors: [String: any ToolExecutor] = [:]
    private var stats: [String: MutableToolExecutionStats] = [:]

    /// Creates a new empty tool registry.
    public init() {}

    public func register(executor: any ToolExecutor) async throws {
        let toolName = executor.tool.name

        guard !toolName.isEmpty else {
            throw ToolRegistryError.emptyToolName
        }

        guard executors[toolName] == nil else {
            throw ToolRegistryError.alreadyRegistered(toolName)
        }

        executors[toolName] = executor
        stats[toolName] = MutableToolExecutionStats()
    }

    public func unregister(toolName: String) async -> Bool {
        let wasPresent = executors.removeValue(forKey: toolName) != nil
        stats.removeValue(forKey: toolName)
        return wasPresent
    }

    public func executor(for toolName: String) async -> (any ToolExecutor)? {
        executors[toolName]
    }

    public func allTools() async -> [Tool] {
        executors.values.map { $0.tool }
    }

    public func isToolRegistered(toolName: String) async -> Bool {
        executors[toolName] != nil
    }

    public func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let toolName = context.toolCall.function.name

        guard let executor = executors[toolName] else {
            throw ToolRegistryError.toolNotFound(toolName)
        }

        let startTime = ContinuousClock.now
        let result: ToolExecutionResult

        do {
            // Validate before executing
            let validation = executor.validate(toolCall: context.toolCall)
            if !validation.isValid {
                throw ToolExecutionError.validationFailed(
                    message: validation.errors.joined(separator: "; ")
                )
            }

            // Execute with timeout if specified
            if let maxTime = executor.maximumExecutionTime() {
                result = try await withTimeout(maxTime, toolName: toolName) {
                    try await executor.execute(context: context)
                }
            } else {
                result = try await executor.execute(context: context)
            }

            // Update success statistics
            let duration = startTime.duration(to: .now)
            stats[toolName]?.recordSuccess(duration: duration)

            return result
        } catch {
            // Update failure statistics
            let duration = startTime.duration(to: .now)
            stats[toolName]?.recordFailure(duration: duration)
            throw error
        }
    }

    public func stats(for toolName: String) async -> ToolExecutionStats? {
        stats[toolName]?.toImmutable()
    }

    public func getAllStats() async -> [String: ToolExecutionStats] {
        stats.mapValues { $0.toImmutable() }
    }

    public func clearStats() async {
        for key in stats.keys {
            stats[key]?.clear()
        }
    }

    public func getAllExecutors() async -> [String: any ToolExecutor] {
        executors
    }
}

// MARK: - MutableToolExecutionStats

/// Mutable version of ToolExecutionStats for internal tracking.
///
/// Value type: all mutation happens through the `DefaultToolRegistry` actor's
/// dictionary subscript (inout), which serialises access — no `@unchecked Sendable` needed.
private struct MutableToolExecutionStats {
    private(set) var executionCount: Int = 0
    private(set) var successCount: Int = 0
    private(set) var failureCount: Int = 0
    private(set) var totalExecutionTime: Duration = .zero
    private(set) var averageExecutionTime: Duration = .zero

    mutating func recordSuccess(duration: Duration) {
        executionCount += 1
        successCount += 1
        totalExecutionTime += duration
        averageExecutionTime = totalExecutionTime / executionCount
    }

    mutating func recordFailure(duration: Duration) {
        executionCount += 1
        failureCount += 1
        totalExecutionTime += duration
        averageExecutionTime = totalExecutionTime / executionCount
    }

    mutating func clear() {
        executionCount = 0
        successCount = 0
        failureCount = 0
        totalExecutionTime = .zero
        averageExecutionTime = .zero
    }

    func toImmutable() -> ToolExecutionStats {
        ToolExecutionStats(
            executionCount: executionCount,
            successCount: successCount,
            failureCount: failureCount,
            totalExecutionTime: totalExecutionTime,
            averageExecutionTime: averageExecutionTime
        )
    }
}

// MARK: - Timeout Helper

/// Executes an operation with a timeout.
///
/// - Parameters:
///   - duration: Maximum time allowed for the operation
///   - operation: The async operation to execute
/// - Returns: The result of the operation
/// - Throws: ``ToolExecutionError/timeout(toolName:duration:)`` if timeout exceeded
private func withTimeout<T>(
    _ duration: Duration,
    toolName: String,
    operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await operation()
        }

        group.addTask {
            try await Task.sleep(for: duration)
            throw ToolExecutionError.timeout(toolName: toolName, duration: duration)
        }

        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}
