// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

struct ChatView: View {
    @EnvironmentObject private var store: ChatAppStore

    let state: ChatUIState
    let onSend: (String) -> Void

    @State private var messageText: String = ""

    var body: some View {
        let background = state.backgroundHex.flatMap { Color(hex: $0) }
            ?? Color(UIColor.systemBackground)

        Group {
            if state.activeAgent == nil {
                EmptyAgentView()
            } else {
                VStack(spacing: 0) {
                    messageList(background: background)

                    // Phase 1A: Render each active ephemeral slot independently.
                    // Slots are sorted by displayPriority so .step appears above .toolCall.
                    let activeSlots = EphemeralSlot.allCases
                        .sorted()
                        .compactMap { slot -> DisplayMessage? in state.ephemeralSlots[slot] }

                    ForEach(activeSlots, id: \.id) { ephemeral in
                        EphemeralBanner(message: ephemeral)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    Divider()
                    inputArea
                }
                // Phase 3C: Animate background color changes smoothly.
                .background(background.animation(.easeInOut(duration: 0.5), value: state.backgroundHex))
            }
        }
        // Phase 3B: Spring animation for new message rows entering the list.
        .animation(.spring(response: 0.38, dampingFraction: 0.82), value: state.chatRows.count)
        .animation(.easeInOut(duration: 0.22), value: state.ephemeralSlots.count)
    }

    // MARK: - Sub-views

    private func messageList(background: Color) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    // Phase 1B: Iterate chatRows (agent messages + supplemental messages).
                    ForEach(state.chatRows) { row in
                        Group {
                            switch row {
                            case .agent(let message):
                                MessageBubbleView(message: message)
                            case .supplemental(let supplemental):
                                SupplementalMessageBubbleView(message: supplemental)
                            }
                        }
                        .id(row.id)
                        // Phase 3B: New rows slide up from below and fade in.
                        .transition(
                            .asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .opacity
                            )
                        )
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 16)
            }
            .background(background.opacity(0.6))
            .onChange(of: state.chatRows.last?.id) { id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }

    private var inputArea: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 12) {
                TextField("Type a message", text: $messageText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1 ... 6)
                    .disabled(!state.isConnected || state.isLoading)

                Button {
                    let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    onSend(trimmed)
                    messageText = ""
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 18, weight: .semibold))
                }
                .buttonStyle(.borderedProminent)
                .disabled(!state.isConnected || state.isLoading)
                .accessibilityLabel("Send")
                .accessibilityHint("Send your message to the agent")
            }

            if state.isLoading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Waiting for response…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel", role: .cancel, action: store.cancelStreaming)
                        .accessibilityLabel("Cancel")
                        .accessibilityHint("Stop waiting for the agent response")
                }
            }
        }
        .padding()
        .background(Material.bar)
    }
}

// MARK: - EphemeralBanner

private struct EphemeralBanner: View {
    let message: DisplayMessage

    private var icon: String {
        switch message.role {
        case .toolCall: return "wrench.adjustable"
        case .stepInfo: return "bolt.fill"
        default: return "info.circle"
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.cyan)
            Text(message.content)
                .font(.footnote)
                .foregroundStyle(.cyan)
            Spacer()
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        switch message.role {
        case .toolCall(let name): return "Running tool: \(name)"
        case .stepInfo(let name): return "Step in progress: \(name)"
        default: return message.content
        }
    }
}

// MARK: - SupplementalMessageBubbleView

/// Renders system lifecycle events (connection status, inline errors) as chat rows.
private struct SupplementalMessageBubbleView: View {
    let message: SupplementalMessage

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: iconName)
                .font(.caption)
                .foregroundStyle(iconColor)
            Text(labelText)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    private var iconName: String {
        switch message.kind {
        case .connection: return "checkmark.circle.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    private var iconColor: Color {
        switch message.kind {
        case .connection: return .green
        case .error: return .orange
        }
    }

    private var labelText: String {
        switch message.kind {
        case .connection(let agentName): return "Connected to \(agentName)"
        case .error(let message): return message
        }
    }
}

// MARK: - EmptyAgentView

private struct EmptyAgentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("Select an agent")
                .font(.headline)
            Text("Choose or create an agent to begin chatting.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Color + Hex

extension Color {
    /// Creates a `Color` from a hex string or a CSS color expression.
    ///
    /// Accepts:
    /// - 6-character hex: `#RRGGBB` or `RRGGBB`
    /// - 8-character hex: `#RRGGBBAA` or `RRGGBBAA`
    /// - CSS gradients / expressions: extracts the first `#RRGGBB` hex found in the string
    init?(hex: String) {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines)

        // Fast path: plain hex string
        let cleaned = trimmed.replacingOccurrences(of: "#", with: "")
        if let value = UInt64(cleaned, radix: 16) {
            switch cleaned.count {
            case 6:
                let r = Double((value & 0xFF0000) >> 16) / 255
                let g = Double((value & 0x00FF00) >> 8) / 255
                let b = Double(value & 0x0000FF) / 255
                self.init(red: r, green: g, blue: b)
                return
            case 8:
                let r = Double((value & 0xFF00_0000) >> 24) / 255
                let g = Double((value & 0x00FF_0000) >> 16) / 255
                let b = Double((value & 0x0000_FF00) >> 8) / 255
                let a = Double(value & 0x0000_00FF) / 255
                self.init(red: r, green: g, blue: b, opacity: a)
                return
            default:
                break
            }
        }

        // Fallback: extract first #RRGGBB hex from a CSS gradient/expression
        if let range = trimmed.range(of: #"#[0-9a-fA-F]{6}"#, options: .regularExpression) {
            let extracted = String(trimmed[range])
            if let color = Color(hex: extracted) {
                self = color
                return
            }
        }

        return nil
    }
}
