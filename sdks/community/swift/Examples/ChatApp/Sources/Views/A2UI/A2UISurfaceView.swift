// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

// MARK: - A2UISurfaceView

/// Root renderer for a single A2UI surface.
///
/// Decodes `surfaceData` once in `init` and falls back to an empty view on
/// parse failure, so the layout never breaks during a streaming patch.
///
/// User interactions are forwarded through `onAction` so no store reference
/// is held inside the view hierarchy — this keeps the view pure and testable.
struct A2UISurfaceView: View {

    let messageId: String
    private let rootComponent: A2UIComponent?
    /// `(messageId, actionId, payload)` — called when the user interacts with
    /// a button, toggle, text field, or select inside this surface.
    let onAction: (String, String, [String: String]) -> Void

    init(
        messageId: String,
        surfaceData: Data?,
        onAction: @escaping (String, String, [String: String]) -> Void
    ) {
        self.messageId = messageId
        self.rootComponent = surfaceData.flatMap {
            try? JSONDecoder().decode(A2UIComponent.self, from: $0)
        }
        self.onAction = onAction
    }

    var body: some View {
        if let root = rootComponent {
            A2UIComponentView(component: root) { actionId, payload in
                onAction(messageId, actionId, payload)
            }
            .padding(12)
            .background(Color(UIColor.secondarySystemBackground).opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
}

// MARK: - Previews

#Preview("Text surface") {
    let json = """
    {"type": "vStack", "children": [
        {"type": "text", "content": "Hello from A2UI", "style": {"fontWeight": "bold"}},
        {"type": "divider"},
        {"type": "button", "label": "Tap me", "actionId": "tap"}
    ]}
    """.data(using: .utf8)

    A2UISurfaceView(
        messageId: "preview-1",
        surfaceData: json,
        onAction: { mId, actionId, payload in
            print("Action: \(actionId) on \(mId), payload: \(payload)")
        }
    )
    .padding()
}
