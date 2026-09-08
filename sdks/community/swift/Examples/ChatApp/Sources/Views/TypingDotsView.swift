// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

// MARK: - TypingDotsView

/// Three animated dots shown while the agent is composing its first token.
///
/// Each dot bounces vertically with a staggered delay, matching the typing
/// indicator style common in modern chat applications.
struct TypingDotsView: View {

    // MARK: - State

    @State private var phase: Bool = false

    // MARK: - Body

    var body: some View {
        HStack(spacing: 5) {
            dot(delay: 0.00)
            dot(delay: 0.18)
            dot(delay: 0.36)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Agent is typing")
        .onAppear {
            withAnimation(
                .easeInOut(duration: 0.54)
                .repeatForever(autoreverses: true)
            ) {
                phase = true
            }
        }
    }

    // MARK: - Private

    private func dot(delay: Double) -> some View {
        Circle()
            .fill(Color.secondary.opacity(0.6))
            .frame(width: 8, height: 8)
            .scaleEffect(phase ? 1.0 : 0.5)
            .offset(y: phase ? -4 : 0)
            .animation(
                .easeInOut(duration: 0.54)
                .repeatForever(autoreverses: true)
                .delay(delay),
                value: phase
            )
    }
}

// MARK: - Previews

#Preview {
    TypingDotsView()
        .padding()
}
