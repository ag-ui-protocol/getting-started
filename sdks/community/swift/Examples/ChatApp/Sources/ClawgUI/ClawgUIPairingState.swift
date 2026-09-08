// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - ClawgUIPairingState

/// Six-state machine mirroring the Kotlin SDK's ClawgUI pairing flow.
///
/// ```
/// idle ──[clawg-ui URL detected]──► initiating
/// initiating ──[403 + pairing info]──► pendingApproval(approvalURL)
/// initiating ──[HTTP error]──► failed(reason)
/// pendingApproval ──[user confirms]──► awaitingApproval
/// awaitingApproval ──[poll 200 OK]──► idle (connected)
/// awaitingApproval ──[poll timeout]──► retryingConnection
/// retryingConnection ──[retry succeeds]──► pendingApproval(url)
/// retryingConnection ──[max retries exhausted]──► failed(reason)
/// failed ──[user dismisses]──► idle
/// ```
enum ClawgUIPairingState: Sendable, Equatable {
    /// No pairing in progress — default state for non-ClawgUI agents.
    case idle

    /// Initial handshake request is in flight.
    case initiating

    /// Handshake returned a 403 with an approval URL; user must open it to authorize.
    case pendingApproval(approvalURL: URL)

    /// User confirmed they authorized; polling the gateway for confirmation.
    case awaitingApproval

    /// Polling timed out; user can tap Retry to re-initiate.
    case retryingConnection

    /// Terminal error state; user must dismiss and reconfigure.
    case failed(reason: String)
}
