// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUITools

final class ToolExecutionStatsTests: XCTestCase {

    // MARK: - Initialization Tests

    func testDefaultInitialization() {
        // When: Creating stats with default values
        let stats = ToolExecutionStats()

        // Then: All counters should be zero
        XCTAssertEqual(stats.executionCount, 0)
        XCTAssertEqual(stats.successCount, 0)
        XCTAssertEqual(stats.failureCount, 0)
        XCTAssertEqual(stats.totalExecutionTime, .zero)
        XCTAssertEqual(stats.averageExecutionTime, .zero)
    }

    func testCustomInitialization() {
        // When: Creating stats with custom values
        let stats = ToolExecutionStats(
            executionCount: 10,
            successCount: 8,
            failureCount: 2,
            totalExecutionTime: .seconds(5),
            averageExecutionTime: .milliseconds(500)
        )

        // Then: Values should match
        XCTAssertEqual(stats.executionCount, 10)
        XCTAssertEqual(stats.successCount, 8)
        XCTAssertEqual(stats.failureCount, 2)
        XCTAssertEqual(stats.totalExecutionTime, .seconds(5))
        XCTAssertEqual(stats.averageExecutionTime, .milliseconds(500))
    }

    // MARK: - Success Rate Tests

    func testSuccessRateWithNoExecutions() {
        // Given: Stats with no executions
        let stats = ToolExecutionStats()

        // When: Calculating success rate
        let successRate = stats.successRate

        // Then: Should be 0.0
        XCTAssertEqual(successRate, 0.0)
    }

    func testSuccessRateAllSuccessful() {
        // Given: Stats with all successful executions
        let stats = ToolExecutionStats(
            executionCount: 10,
            successCount: 10,
            failureCount: 0
        )

        // When: Calculating success rate
        let successRate = stats.successRate

        // Then: Should be 1.0 (100%)
        XCTAssertEqual(successRate, 1.0)
    }

    func testSuccessRateAllFailed() {
        // Given: Stats with all failed executions
        let stats = ToolExecutionStats(
            executionCount: 5,
            successCount: 0,
            failureCount: 5
        )

        // When: Calculating success rate
        let successRate = stats.successRate

        // Then: Should be 0.0 (0%)
        XCTAssertEqual(successRate, 0.0)
    }

    func testSuccessRateMixed() {
        // Given: Stats with mixed results
        let stats = ToolExecutionStats(
            executionCount: 10,
            successCount: 7,
            failureCount: 3
        )

        // When: Calculating success rate
        let successRate = stats.successRate

        // Then: Should be 0.7 (70%)
        XCTAssertEqual(successRate, 0.7, accuracy: 0.01)
    }

    // MARK: - Sendable Conformance

    func testSendableAcrossActors() async {
        // Given: Stats instance
        let stats = ToolExecutionStats(
            executionCount: 5,
            successCount: 4,
            failureCount: 1
        )

        // When: Passing to an actor
        actor StatsHolder {
            var stats: ToolExecutionStats?

            func store(_ stats: ToolExecutionStats) {
                self.stats = stats
            }
        }

        let holder = StatsHolder()
        await holder.store(stats)

        // Then: No compiler errors (Sendable conformance)
        // This test verifies that ToolExecutionStats is Sendable
    }

    // MARK: - Equatable Conformance

    func testEquatableIdenticalStats() {
        // Given: Two identical stats
        let stats1 = ToolExecutionStats(
            executionCount: 5,
            successCount: 3,
            failureCount: 2,
            totalExecutionTime: .seconds(1),
            averageExecutionTime: .milliseconds(200)
        )
        let stats2 = ToolExecutionStats(
            executionCount: 5,
            successCount: 3,
            failureCount: 2,
            totalExecutionTime: .seconds(1),
            averageExecutionTime: .milliseconds(200)
        )

        // Then: They should be equal
        XCTAssertEqual(stats1, stats2)
    }

    func testEquatableDifferentStats() {
        // Given: Two different stats
        let stats1 = ToolExecutionStats(executionCount: 5)
        let stats2 = ToolExecutionStats(executionCount: 10)

        // Then: They should not be equal
        XCTAssertNotEqual(stats1, stats2)
    }

    // MARK: - Edge Cases

    func testLargeExecutionCount() {
        // Given: Stats with very large execution count
        let stats = ToolExecutionStats(
            executionCount: Int.max / 2,
            successCount: Int.max / 4,
            failureCount: Int.max / 4
        )

        // Then: Success rate should still calculate correctly
        let successRate = stats.successRate
        XCTAssertEqual(successRate, 0.5, accuracy: 0.01)
    }

    func testLongDuration() {
        // Given: Stats with very long duration
        let stats = ToolExecutionStats(
            executionCount: 1,
            successCount: 1,
            failureCount: 0,
            totalExecutionTime: .seconds(3600), // 1 hour
            averageExecutionTime: .seconds(3600)
        )

        // Then: Duration values should be preserved
        XCTAssertEqual(stats.totalExecutionTime, .seconds(3600))
        XCTAssertEqual(stats.averageExecutionTime, .seconds(3600))
    }

    func testZeroDuration() {
        // Given: Stats with zero duration
        let stats = ToolExecutionStats(
            executionCount: 5,
            totalExecutionTime: .zero,
            averageExecutionTime: .zero
        )

        // Then: Zero durations should be handled correctly
        XCTAssertEqual(stats.totalExecutionTime, .zero)
        XCTAssertEqual(stats.averageExecutionTime, .zero)
    }

    // MARK: - Consistency Tests

    func testExecutionCountConsistency() {
        // Given: Stats where success + failure equals total
        let stats = ToolExecutionStats(
            executionCount: 10,
            successCount: 6,
            failureCount: 4
        )

        // Then: Success + failure should equal execution count
        XCTAssertEqual(stats.successCount + stats.failureCount, stats.executionCount)
    }

    func testAverageExecutionTimeConsistency() {
        // Given: Stats with consistent average
        let totalTime: Duration = .seconds(10)
        let execCount = 5
        let avgTime: Duration = .seconds(2) // 10 / 5 = 2

        let stats = ToolExecutionStats(
            executionCount: execCount,
            totalExecutionTime: totalTime,
            averageExecutionTime: avgTime
        )

        // Then: Average should match total / count
        let calculatedAverage = stats.totalExecutionTime / execCount
        XCTAssertEqual(stats.averageExecutionTime, calculatedAverage)
    }
}
