// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import ChatApp

// MARK: - Mock HTTP Client

/// Controllable HTTP client for pairing manager tests.
/// @unchecked Sendable because test properties are mutated from the main actor only.
final class MockClawgUIPairingHTTPClient: ClawgUIPairingHTTPClient, @unchecked Sendable {

    // MARK: - Handshake control

    enum HandshakeResult {
        case success(approvalURL: URL)
        case failure(Error)
    }

    var handshakeResult: HandshakeResult = .success(
        approvalURL: URL(string: "https://clawg-ui.example.com/approve")!
    )
    var handshakeCallCount = 0

    // MARK: - Poll control

    var pollResult = false
    var pollError: Error?
    var pollCallCount = 0
    /// Artificial async delay injected before returning poll result (seconds).
    var pollDelay: TimeInterval = 0

    // MARK: - ClawgUIPairingHTTPClient

    func initiateHandshake(agentURL: URL) async throws -> ClawgUIHandshakeResult {
        handshakeCallCount += 1
        switch handshakeResult {
        case .success(let url):
            return ClawgUIHandshakeResult(approvalURL: url)
        case .failure(let error):
            throw error
        }
    }

    func pollApprovalStatus(agentURL: URL) async throws -> Bool {
        pollCallCount += 1
        if pollDelay > 0 {
            try await Task.sleep(for: .seconds(pollDelay))
        }
        if let error = pollError { throw error }
        return pollResult
    }
}

// MARK: - ClawgUIPairingManagerTests

@MainActor
final class ClawgUIPairingManagerTests: XCTestCase {

    private let agentURL = URL(string: "https://gateway.enterprise.com/v1/clawg-ui")!
    private let approvalURL = URL(string: "https://clawg-ui.example.com/approve")!

    private func makeManager(client: MockClawgUIPairingHTTPClient) -> ClawgUIPairingManager {
        ClawgUIPairingManager(
            httpClient: client,
            maxPollingAttempts: 3,
            pollingInterval: .milliseconds(10) // fast for tests
        )
    }

    // MARK: - Initial state

    func test_initialState_isIdle() {
        let manager = makeManager(client: MockClawgUIPairingHTTPClient())
        XCTAssertEqual(manager.pairingState, .idle)
    }

    // MARK: - Initiate pairing

    func test_initiatePairing_passesInitiatingStateToCallback() async {
        let client = MockClawgUIPairingHTTPClient()
        let manager = makeManager(client: client)

        var observed: [ClawgUIPairingState] = []
        manager.onStateChange = { observed.append($0) }

        await manager.initiatePairing(agentURL: agentURL)

        XCTAssertTrue(observed.contains(.initiating), "Expected .initiating in \(observed)")
    }

    func test_initiatePairing_successfulHandshake_transitionsToPendingApproval() async {
        let client = MockClawgUIPairingHTTPClient()
        client.handshakeResult = .success(approvalURL: approvalURL)
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)

        guard case .pendingApproval(let url) = manager.pairingState else {
            return XCTFail("Expected .pendingApproval, got \(manager.pairingState)")
        }
        XCTAssertEqual(url, approvalURL)
    }

    func test_initiatePairing_httpError_transitionsToFailed() async {
        let client = MockClawgUIPairingHTTPClient()
        client.handshakeResult = .failure(NSError(domain: "test", code: -1, userInfo: [NSLocalizedDescriptionKey: "Network error"]))
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)

        guard case .failed(let reason) = manager.pairingState else {
            return XCTFail("Expected .failed, got \(manager.pairingState)")
        }
        XCTAssertFalse(reason.isEmpty)
    }

    func test_initiatePairing_callsHandshakeOnce() async {
        let client = MockClawgUIPairingHTTPClient()
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)

        XCTAssertEqual(client.handshakeCallCount, 1)
    }

    // MARK: - Confirm approval

    func test_confirmApproval_transitionsToAwaitingApproval() async {
        let client = MockClawgUIPairingHTTPClient()
        client.pollResult = false
        client.pollDelay = 60 // long delay so polling doesn't complete during test
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)
        manager.confirmApproval()

        XCTAssertEqual(manager.pairingState, .awaitingApproval)
    }

    // MARK: - Polling success

    func test_pollingSuccess_transitionsToIdle() async throws {
        let client = MockClawgUIPairingHTTPClient()
        client.pollResult = true

        let expectation = expectation(description: "pairing success")
        let manager = makeManager(client: client)
        manager.onPairingSuccess = { expectation.fulfill() }

        await manager.initiatePairing(agentURL: agentURL)
        manager.confirmApproval()

        await fulfillment(of: [expectation], timeout: 2)
        XCTAssertEqual(manager.pairingState, .idle)
    }

    func test_pollingSuccess_callsOnPairingSuccessOnce() async throws {
        let client = MockClawgUIPairingHTTPClient()
        client.pollResult = true

        let expectation = expectation(description: "pairing success")
        expectation.assertForOverFulfill = true
        let manager = makeManager(client: client)
        manager.onPairingSuccess = { expectation.fulfill() }

        await manager.initiatePairing(agentURL: agentURL)
        manager.confirmApproval()

        await fulfillment(of: [expectation], timeout: 2)
    }

    // MARK: - Polling exhaustion

    func test_pollingExhausted_transitionsToRetryingConnection() async throws {
        let client = MockClawgUIPairingHTTPClient()
        client.pollResult = false // never approve

        let expectation = expectation(description: "retrying connection")
        let manager = makeManager(client: client) // maxPollingAttempts = 3

        manager.onStateChange = { state in
            if state == .retryingConnection { expectation.fulfill() }
        }

        await manager.initiatePairing(agentURL: agentURL)
        manager.confirmApproval()

        await fulfillment(of: [expectation], timeout: 5)
        XCTAssertEqual(manager.pairingState, .retryingConnection)
    }

    // MARK: - Reset

    func test_reset_setsStateToIdle() async {
        let client = MockClawgUIPairingHTTPClient()
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)
        manager.reset()

        XCTAssertEqual(manager.pairingState, .idle)
    }

    func test_reset_cancelsInFlightPolling() async throws {
        let client = MockClawgUIPairingHTTPClient()
        client.pollResult = false
        client.pollDelay = 60 // long delay
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)
        manager.confirmApproval()
        manager.reset()

        // After reset, state is idle and polling is cancelled
        XCTAssertEqual(manager.pairingState, .idle)
        // Poll should not have completed (cancelled before delay elapsed)
        XCTAssertEqual(client.pollCallCount, 0)
    }

    func test_reset_firesOnStateChangeWithIdle() async {
        let client = MockClawgUIPairingHTTPClient()
        let manager = makeManager(client: client)

        var lastState: ClawgUIPairingState?
        manager.onStateChange = { lastState = $0 }

        await manager.initiatePairing(agentURL: agentURL)
        manager.reset()

        XCTAssertEqual(lastState, .idle)
    }

    // MARK: - Retry connection

    func test_retryConnection_performsNewHandshake() async {
        let client = MockClawgUIPairingHTTPClient()
        client.handshakeResult = .success(approvalURL: approvalURL)
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)
        await manager.retryConnection()

        XCTAssertEqual(client.handshakeCallCount, 2)
    }

    func test_retryConnection_successTransitionsToPendingApproval() async {
        let client = MockClawgUIPairingHTTPClient()
        let manager = makeManager(client: client)

        await manager.initiatePairing(agentURL: agentURL)
        await manager.retryConnection()

        guard case .pendingApproval = manager.pairingState else {
            return XCTFail("Expected .pendingApproval, got \(manager.pairingState)")
        }
    }

    // MARK: - State change callback

    func test_onStateChange_firedForEveryTransition() async {
        let client = MockClawgUIPairingHTTPClient()
        let manager = makeManager(client: client)

        var states: [ClawgUIPairingState] = []
        manager.onStateChange = { states.append($0) }

        await manager.initiatePairing(agentURL: agentURL)

        // Should have seen .initiating, then .pendingApproval
        XCTAssertEqual(states.count, 2)
        XCTAssertEqual(states[0], .initiating)
        if case .pendingApproval = states[1] { } else {
            XCTFail("Expected .pendingApproval as second state")
        }
    }
}
