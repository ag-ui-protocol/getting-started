// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

// MARK: - ClawgUIPairingView

/// Sheet modal for the ClawgUI enterprise pairing flow.
///
/// Pure presentational view — all state transitions are handled by callbacks
/// passed in from the store. No business logic lives here.
struct ClawgUIPairingView: View {
    let state: ClawgUIPairingState
    let onConfirm: () -> Void
    let onRetry: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .initiating:
                    InitiatingView()

                case .pendingApproval(let url):
                    PendingApprovalView(approvalURL: url, onConfirm: onConfirm)

                case .awaitingApproval:
                    AwaitingApprovalView()

                case .retryingConnection:
                    RetryingConnectionView(onRetry: onRetry)

                case .failed(let reason):
                    FailedView(reason: reason, onRetry: onRetry)

                case .idle:
                    // Sheet is dismissed when state is .idle; nothing to render.
                    EmptyView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Enterprise Pairing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel", action: onDismiss)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Sub-views

private struct InitiatingView: View {
    var body: some View {
        VStack(spacing: 20) {
            ProgressView()
                .controlSize(.large)
            Text("Connecting to Gateway…")
                .font(.headline)
            Text("Initiating the ClawgUI enterprise handshake.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

private struct PendingApprovalView: View {
    let approvalURL: URL
    let onConfirm: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 64))
                .foregroundStyle(.tint)

            Text("Enterprise Authorization Required")
                .font(.title2)
                .fontWeight(.semibold)
                .multilineTextAlignment(.center)

            Text("Open the link below in your browser to authorize access to this agent, then tap Continue.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Link(destination: approvalURL) {
                Label("Open Authorization Page", systemImage: "safari")
            }
            .buttonStyle(.bordered)

            Button(action: onConfirm) {
                Label("Continue — I've Authorized", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

private struct AwaitingApprovalView: View {
    var body: some View {
        VStack(spacing: 20) {
            ProgressView()
                .controlSize(.large)
            Text("Awaiting Approval")
                .font(.headline)
            Text("Checking with the gateway. This may take a moment.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

private struct RetryingConnectionView: View {
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "arrow.clockwise.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.orange)

            Text("Connection Timed Out")
                .font(.headline)

            Text("The authorization check timed out. Visit the approval page again, then tap Retry.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button(action: onRetry) {
                Label("Retry", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

private struct FailedView: View {
    let reason: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.red)

            Text("Pairing Failed")
                .font(.headline)

            Text(reason)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button(action: onRetry) {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

// MARK: - Previews

#Preview("Initiating") {
    ClawgUIPairingView(
        state: .initiating,
        onConfirm: {},
        onRetry: {},
        onDismiss: {}
    )
}

#Preview("Pending Approval") {
    ClawgUIPairingView(
        state: .pendingApproval(approvalURL: URL(string: "https://clawg-ui.enterprise.com/approve?token=abc123")!),
        onConfirm: {},
        onRetry: {},
        onDismiss: {}
    )
}

#Preview("Awaiting Approval") {
    ClawgUIPairingView(
        state: .awaitingApproval,
        onConfirm: {},
        onRetry: {},
        onDismiss: {}
    )
}

#Preview("Retrying Connection") {
    ClawgUIPairingView(
        state: .retryingConnection,
        onConfirm: {},
        onRetry: {},
        onDismiss: {}
    )
}

#Preview("Failed") {
    ClawgUIPairingView(
        state: .failed(reason: "Network connection refused by the enterprise gateway."),
        onConfirm: {},
        onRetry: {},
        onDismiss: {}
    )
}
