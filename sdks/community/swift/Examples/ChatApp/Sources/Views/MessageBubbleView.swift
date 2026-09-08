// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import MarkdownUI
import SwiftUI

struct MessageBubbleView: View {
    @EnvironmentObject private var store: ChatAppStore
    let message: DisplayMessage

    private var isUser: Bool { message.role == .user }

    private var bubbleColor: Color {
        switch message.role {
        case .user: return .accentColor
        case .assistant: return Color(UIColor.secondarySystemBackground)
        case .system: return Color(UIColor.systemGray5)
        case .error: return Color.red.opacity(0.15)
        case .toolCall: return Color.yellow.opacity(0.2)
        case .stepInfo: return Color.blue.opacity(0.12)
        case .a2uiSurface: return .clear
        }
    }

    private var textColor: Color {
        switch message.role {
        case .user: return .white
        case .error: return .red
        default: return .primary
        }
    }

    private var leadingIcon: String? {
        switch message.role {
        case .user: return nil
        case .assistant: return "sparkles"
        case .system: return "info.circle"
        case .error: return "exclamationmark.triangle"
        case .toolCall: return "wrench.adjustable"
        case .stepInfo: return "bolt.fill"
        case .a2uiSurface: return nil
        }
    }

    var body: some View {
        // Phase 4: A2UI surfaces render full-width without a standard bubble.
        if case .a2uiSurface(let messageId) = message.role {
            A2UISurfaceView(
                messageId: messageId,
                surfaceData: store.state.a2uiSurfaces[messageId]
            ) { mId, actionId, payload in
                store.handleA2UIAction(messageId: mId, actionId: actionId, payload: payload)
            }
        } else {
            standardBubble
        }
    }

    // MARK: - Standard bubble layout

    private var standardBubble: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 6) {
                    if let icon = leadingIcon {
                        Image(systemName: icon)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    // Phase 3A: Typing indicator while waiting for first token;
                    // inline blinking cursor once text is arriving.
                    if message.showsTypingIndicator {
                        TypingDotsView()
                    } else {
                        HStack(alignment: .bottom, spacing: 4) {
                            Markdown(message.content)
                                .markdownTheme(.basic)
                                .markdownTextStyle(\.text) {
                                    ForegroundColor(textColor)
                                }
                                .markdownTextStyle(\.strong) {
                                    FontWeight(.heavy)
                                    ForegroundColor(textColor)
                                }
                                .markdownTextStyle(\.link) {
                                    ForegroundColor(textColor)
                                }
                                .textSelection(.enabled)

                            if message.showsStreamingCursor {
                                StreamingCursorView()
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
                .padding(12)
                .background(bubbleColor)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                HStack(spacing: 4) {
                    Text(message.timestamp.formatted(date: .omitted, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    // Phase 1C: Optimistic send indicator — visible until agent confirms.
                    if message.isSending {
                        Image(systemName: "clock")
                            .font(.caption2)
                            .foregroundStyle(.secondary.opacity(0.6))
                    }
                }
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            }

            if !isUser { Spacer(minLength: 40) }
        }
    }
}
