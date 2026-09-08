// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - ClawgUIPairingHTTPClient

/// Abstraction over the ClawgUI gateway HTTP operations.
///
/// Inject a mock in tests; use `LiveClawgUIPairingHTTPClient` in production.
protocol ClawgUIPairingHTTPClient: Sendable {
    /// Performs the initial pairing handshake.
    ///
    /// Expected server behaviour (TBD): `POST agentURL` returns HTTP 403 with a JSON body
    /// containing an `approvalURL` the user must visit to authorize the connection.
    ///
    /// - Throws: Any transport or decoding error.
    func initiateHandshake(agentURL: URL) async throws -> ClawgUIHandshakeResult

    /// Polls the gateway to check whether the user has approved the pairing.
    ///
    /// Expected server behaviour (TBD): `GET agentURL` returns 200 when approved,
    /// 403 when still pending.
    ///
    /// - Returns: `true` when the gateway confirms approval.
    /// - Throws: Any transport error.
    func pollApprovalStatus(agentURL: URL) async throws -> Bool
}

// MARK: - ClawgUIHandshakeResult

struct ClawgUIHandshakeResult: Sendable {
    let approvalURL: URL
}

// MARK: - ClawgUIPairingError

enum ClawgUIPairingError: Error, LocalizedError {
    case handshakeFailed(String)
    case pollingFailed(String)
    case noAgentURL

    var errorDescription: String? {
        switch self {
        case .handshakeFailed(let r): return "Handshake failed: \(r)"
        case .pollingFailed(let r): return "Polling failed: \(r)"
        case .noAgentURL: return "No agent URL configured for retry"
        }
    }
}

// MARK: - LiveClawgUIPairingHTTPClient

/// Production HTTP client for ClawgUI pairing.
///
/// - Important: The exact request/response format is pending confirmation
///   from the ClawgUI server specification. Both methods throw until the
///   spec is confirmed and implemented.
struct LiveClawgUIPairingHTTPClient: ClawgUIPairingHTTPClient {

    // TODO: Implement once the ClawgUI gateway pairing protocol is confirmed.
    // Expected handshake: POST to agentURL → 403 with JSON { "approvalURL": "..." }
    func initiateHandshake(agentURL: URL) async throws -> ClawgUIHandshakeResult {
        throw ClawgUIPairingError.handshakeFailed(
            "Not yet implemented — awaiting ClawgUI server specification"
        )
    }

    // TODO: Implement once the ClawgUI gateway polling protocol is confirmed.
    // Expected poll: GET agentURL → 200 (approved) or 403 (pending)
    func pollApprovalStatus(agentURL: URL) async throws -> Bool {
        throw ClawgUIPairingError.pollingFailed(
            "Not yet implemented — awaiting ClawgUI server specification"
        )
    }
}

// MARK: - ClawgUIPairingManager

/// Drives the ClawgUI enterprise pairing state machine.
///
/// Runs on the main actor so it shares the store's isolation domain and can be
/// accessed from SwiftUI callbacks without actor hops.
///
/// The pairing flow is UI-driven:
/// 1. `initiatePairing(agentURL:)` — performs the gateway handshake.
/// 2. User opens the `approvalURL` in a browser.
/// 3. `confirmApproval()` — user taps "I've Authorized", begins polling.
/// 4. Polling confirms → `onPairingSuccess` fires → store builds the agent.
/// 5. `reset()` at any point returns to `.idle` and cancels in-flight polling.
@MainActor
final class ClawgUIPairingManager {

    // MARK: - Observed state

    /// Current position in the pairing state machine.
    private(set) var pairingState: ClawgUIPairingState = .idle

    // MARK: - Callbacks

    /// Fired on every state transition. Use to mirror state into `ChatUIState`.
    var onStateChange: ((ClawgUIPairingState) -> Void)?

    /// Fired exactly once when polling confirms the user approved the pairing.
    var onPairingSuccess: (() -> Void)?

    // MARK: - Private state

    private let httpClient: any ClawgUIPairingHTTPClient
    private var pollingTask: Task<Void, Never>?
    private var pairingAgentURL: URL?

    let maxPollingAttempts: Int
    var pollingInterval: Duration

    // MARK: - Init

    init(
        httpClient: any ClawgUIPairingHTTPClient = LiveClawgUIPairingHTTPClient(),
        maxPollingAttempts: Int = 5,
        pollingInterval: Duration = .seconds(2)
    ) {
        self.httpClient = httpClient
        self.maxPollingAttempts = maxPollingAttempts
        self.pollingInterval = pollingInterval
    }

    // MARK: - Public interface

    /// Performs the initial gateway handshake for the given agent URL.
    ///
    /// Transitions: `.idle` → `.initiating` → `.pendingApproval` or `.failed`.
    func initiatePairing(agentURL: URL) async {
        pairingAgentURL = agentURL
        transition(to: .initiating)
        do {
            let result = try await httpClient.initiateHandshake(agentURL: agentURL)
            transition(to: .pendingApproval(approvalURL: result.approvalURL))
        } catch {
            transition(to: .failed(reason: error.localizedDescription))
        }
    }

    /// Called when the user taps "I've Authorized". Starts approval polling.
    ///
    /// Transitions: `.pendingApproval` → `.awaitingApproval`
    func confirmApproval() {
        transition(to: .awaitingApproval)
        startPolling()
    }

    /// Re-initiates the handshake. Intended for the `retryingConnection` and
    /// `failed` states when the user taps "Try Again".
    func retryConnection() async {
        guard let agentURL = pairingAgentURL else {
            transition(to: .failed(reason: ClawgUIPairingError.noAgentURL.localizedDescription ?? ""))
            return
        }
        await initiatePairing(agentURL: agentURL)
    }

    /// Cancels all in-flight operations and returns to `.idle`.
    func reset() {
        pollingTask?.cancel()
        pollingTask = nil
        pairingAgentURL = nil
        transition(to: .idle)
    }

    // MARK: - Private helpers

    private func transition(to newState: ClawgUIPairingState) {
        pairingState = newState
        onStateChange?(newState)
    }

    private func startPolling() {
        guard let agentURL = pairingAgentURL else { return }
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            guard let self else { return }
            var attempts = 0
            while attempts < self.maxPollingAttempts {
                if Task.isCancelled { return }
                try? await Task.sleep(for: self.pollingInterval)
                if Task.isCancelled { return }
                do {
                    let approved = try await self.httpClient.pollApprovalStatus(agentURL: agentURL)
                    if approved {
                        self.transition(to: .idle)
                        self.onPairingSuccess?()
                        return
                    }
                } catch {
                    // Network error during poll — treat as non-approval and continue
                }
                attempts += 1
            }
            // All polling attempts exhausted — user must explicitly retry
            self.transition(to: .retryingConnection)
        }
    }
}
