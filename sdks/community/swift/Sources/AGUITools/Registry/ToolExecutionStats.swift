// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Statistics about tool execution.
///
/// `ToolExecutionStats` tracks execution metrics for a tool, including counts
/// of executions, successes, failures, and timing information. These statistics
/// are useful for monitoring tool performance, identifying problematic tools,
/// and debugging execution issues.
///
/// ## Usage
///
/// ```swift
/// // Get stats from a registry
/// let stats = await registry.stats(for: "my_tool")
/// print("Success rate: \(stats.successRate * 100)%")
/// print("Average time: \(stats.averageExecutionTime)")
/// ```
///
/// ## Metrics Tracked
///
/// - **Execution counts**: Total, successful, and failed executions
/// - **Success rate**: Percentage of successful executions
/// - **Timing**: Total and average execution time
///
/// ## Design Notes
///
/// - Immutable value type for thread safety
/// - Sendable for safe concurrent access
/// - Success rate computed property for convenience
///
/// - SeeAlso: ``ToolRegistry``, ``DefaultToolRegistry``
public struct ToolExecutionStats: Sendable, Equatable, Hashable {
    /// Total number of executions (successes + failures).
    public let executionCount: Int

    /// Number of successful executions.
    public let successCount: Int

    /// Number of failed executions.
    public let failureCount: Int

    /// Total time spent executing the tool across all executions.
    public let totalExecutionTime: Duration

    /// Average execution time per invocation.
    public let averageExecutionTime: Duration

    /// Creates new execution statistics.
    ///
    /// - Parameters:
    ///   - executionCount: Total number of executions (defaults to 0)
    ///   - successCount: Number of successful executions (defaults to 0)
    ///   - failureCount: Number of failed executions (defaults to 0)
    ///   - totalExecutionTime: Total time spent executing (defaults to zero)
    ///   - averageExecutionTime: Average execution time (defaults to zero)
    public init(
        executionCount: Int = 0,
        successCount: Int = 0,
        failureCount: Int = 0,
        totalExecutionTime: Duration = .zero,
        averageExecutionTime: Duration = .zero
    ) {
        self.executionCount = executionCount
        self.successCount = successCount
        self.failureCount = failureCount
        self.totalExecutionTime = totalExecutionTime
        self.averageExecutionTime = averageExecutionTime
    }

    /// Success rate as a decimal between 0.0 and 1.0.
    ///
    /// Calculated as `successCount / executionCount`. Returns 0.0 if there
    /// have been no executions.
    ///
    /// ## Examples
    ///
    /// - 10 successes out of 10 executions = 1.0 (100%)
    /// - 7 successes out of 10 executions = 0.7 (70%)
    /// - 0 executions = 0.0
    public var successRate: Double {
        guard executionCount > 0 else { return 0.0 }
        return Double(successCount) / Double(executionCount)
    }
}
