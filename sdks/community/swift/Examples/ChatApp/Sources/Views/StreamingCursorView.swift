// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

// MARK: - StreamingCursorView

/// A blinking vertical bar appended to a streaming message bubble.
///
/// Signals that the agent's response is still arriving. Fades out smoothly
/// when the message's `isStreaming` flag transitions to `false`.
struct StreamingCursorView: View {

    // MARK: - State

    @State private var visible: Bool = true

    // MARK: - Body

    var body: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(Color.secondary.opacity(0.7))
            .frame(width: 2, height: 14)
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(
                    .easeInOut(duration: 0.52)
                    .repeatForever(autoreverses: true)
                ) {
                    visible = false
                }
            }
    }
}

// MARK: - Previews

#Preview {
    HStack {
        Text("Streaming text")
        StreamingCursorView()
    }
    .padding()
}
