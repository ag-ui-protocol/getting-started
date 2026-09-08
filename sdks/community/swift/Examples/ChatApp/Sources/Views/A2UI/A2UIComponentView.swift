// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import MarkdownUI
import SwiftUI

// MARK: - A2UIComponentView

/// Recursively renders a single `A2UIComponent` node.
///
/// User interactions (button taps, toggle changes, text input) are reported
/// through `onAction` rather than stored internally — the call site routes
/// these back to the agent via `ChatAppStore.handleA2UIAction`.
struct A2UIComponentView: View {

    let component: A2UIComponent
    /// `(actionId, payload)` — called on button taps and interactive control changes.
    let onAction: (String, [String: String]) -> Void

    var body: some View {
        switch component {
        case .text(let content, let style):
            StyledText(content: content, style: style)

        case .button(let label, let actionId):
            Button(label) { onAction(actionId, [:]) }
                .buttonStyle(.bordered)

        case .vStack(let children):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                    A2UIComponentView(component: child, onAction: onAction)
                }
            }

        case .hStack(let children):
            HStack(spacing: 8) {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                    A2UIComponentView(component: child, onAction: onAction)
                }
            }

        case .image(let url, let altText):
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    Image(systemName: "photo.badge.exclamationmark")
                        .foregroundStyle(.secondary)
                default:
                    ProgressView()
                }
            }
            .accessibilityLabel(altText ?? "Image")

        case .divider:
            Divider()

        case .card(let title, let children):
            CardView(title: title, children: children, onAction: onAction)

        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        A2UIComponentView(component: item, onAction: onAction)
                    }
                }
            }

        case .badge(let label, let color):
            BadgeView(label: label, hex: color)

        case .textField(let placeholder, let bindingKey):
            BoundTextField(placeholder: placeholder, bindingKey: bindingKey, onAction: onAction)

        case .toggle(let label, let bindingKey, let initialValue):
            BoundToggle(label: label, bindingKey: bindingKey, initialValue: initialValue, onAction: onAction)

        case .select(let label, let options, let bindingKey):
            BoundSelect(label: label, options: options, bindingKey: bindingKey, onAction: onAction)

        case .progress(let value, let total):
            VStack(alignment: .leading, spacing: 2) {
                ProgressView(value: value, total: total)
                Text("\(Int((value / max(total, 1)) * 100))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        case .markdown(let content):
            Markdown(content)
                .markdownTheme(.basic)

        case .spacer(let height):
            if let h = height {
                Spacer().frame(height: h)
            } else {
                Spacer()
            }

        case .chart:
            // Charts require iOS 16+ Charts framework. Rendered as a placeholder
            // until a chart rendering library is integrated.
            HStack {
                Image(systemName: "chart.bar.xaxis")
                    .foregroundStyle(.secondary)
                Text("Chart (unsupported)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(8)
            .background(Color(UIColor.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .table(let headers, let rows):
            TableView(headers: headers, rows: rows)

        case .unknown:
            EmptyView()
        }
    }
}

// MARK: - Sub-views

private struct StyledText: View {
    let content: String
    let style: TextStyle?

    var body: some View {
        Text(content)
            .font(resolvedFont)
            .foregroundColor(resolvedColor)
            .multilineTextAlignment(resolvedAlignment)
    }

    private var resolvedFont: Font {
        let weight: Font.Weight
        switch style?.fontWeight {
        case "bold": weight = .bold
        case "semibold": weight = .semibold
        case "light": weight = .light
        default: weight = .regular
        }
        if let size = style?.fontSize {
            // Fixed size requested: honour it exactly, but still apply the weight.
            return .system(size: size, weight: weight)
        }
        // No explicit size — use .body so Dynamic Type scaling is preserved.
        return .body.weight(weight)
    }

    private var resolvedColor: Color? {
        guard let hex = style?.color else { return nil }
        return Color(hex: hex)
    }

    private var resolvedAlignment: TextAlignment {
        switch style?.alignment {
        case "center": return .center
        case "trailing": return .trailing
        default: return .leading
        }
    }
}

private struct CardView: View {
    let title: String?
    let children: [A2UIComponent]
    let onAction: (String, [String: String]) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let t = title {
                Text(t).font(.headline)
            }
            ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                A2UIComponentView(component: child, onAction: onAction)
            }
        }
        .padding(12)
        .background(Color(UIColor.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct BadgeView: View {
    let label: String
    let hex: String?

    private var badgeColor: Color {
        (hex.flatMap { Color(hex: $0) }) ?? .accentColor
    }

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(badgeColor.opacity(0.15))
            .foregroundColor(badgeColor)
            .clipShape(Capsule())
    }
}

private struct BoundTextField: View {
    let placeholder: String
    let bindingKey: String
    let onAction: (String, [String: String]) -> Void

    @State private var text: String = ""

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.roundedBorder)
            .onSubmit { onAction("text_submitted", [bindingKey: text]) }
    }
}

private struct BoundToggle: View {
    let label: String
    let bindingKey: String
    let initialValue: Bool
    let onAction: (String, [String: String]) -> Void

    @State private var isOn: Bool

    init(label: String, bindingKey: String, initialValue: Bool, onAction: @escaping (String, [String: String]) -> Void) {
        self.label = label
        self.bindingKey = bindingKey
        self.initialValue = initialValue
        self.onAction = onAction
        _isOn = State(initialValue: initialValue)
    }

    var body: some View {
        Toggle(label, isOn: $isOn)
            .onChange(of: isOn) { value in
                onAction("toggle_changed", [bindingKey: value ? "true" : "false"])
            }
    }
}

private struct BoundSelect: View {
    let label: String
    let options: [String]
    let bindingKey: String
    let onAction: (String, [String: String]) -> Void

    @State private var selection: String

    init(label: String, options: [String], bindingKey: String, onAction: @escaping (String, [String: String]) -> Void) {
        self.label = label
        self.options = options
        self.bindingKey = bindingKey
        self.onAction = onAction
        _selection = State(initialValue: options.first ?? "")
    }

    var body: some View {
        Picker(label, selection: $selection) {
            ForEach(options, id: \.self) { option in
                Text(option).tag(option)
            }
        }
        .pickerStyle(.menu)
        .onChange(of: selection) { value in
            onAction("select_changed", [bindingKey: value])
        }
    }
}

private struct TableView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                ForEach(headers, id: \.self) { header in
                    Text(header)
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Color(UIColor.tertiarySystemBackground))
                }
            }
            Divider()
            // Data rows
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        Text(cell)
                            .font(.caption)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                }
                .background(rowIdx % 2 == 0 ? Color.clear : Color(UIColor.secondarySystemBackground).opacity(0.5))
                if rowIdx < rows.count - 1 { Divider() }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(UIColor.separator), lineWidth: 0.5))
    }
}

// MARK: - Previews

#Preview("Button") {
    A2UIComponentView(
        component: .button(label: "Click me", actionId: "action_1"),
        onAction: { id, _ in print("Action:", id) }
    )
    .padding()
}

#Preview("Card with children") {
    A2UIComponentView(
        component: .card(title: "Stats", children: [
            .text(content: "Score: 100", style: TextStyle(fontWeight: "bold")),
            .progress(value: 0.7, total: 1.0),
            .button(label: "View Details", actionId: "view_details")
        ]),
        onAction: { _, _ in }
    )
    .padding()
}

#Preview("Table") {
    A2UIComponentView(
        component: .table(
            headers: ["Name", "Score", "Rank"],
            rows: [["Alice", "100", "1st"], ["Bob", "90", "2nd"], ["Carol", "85", "3rd"]]
        ),
        onAction: { _, _ in }
    )
    .padding()
}
