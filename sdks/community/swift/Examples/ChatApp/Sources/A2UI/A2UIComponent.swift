// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - TextStyle

/// Optional visual style hints attached to a `.text` component.
struct TextStyle: Decodable, Sendable {
    /// Font size in points.
    var fontSize: CGFloat?
    /// Font weight descriptor: `"bold"`, `"semibold"`, `"light"`, `"regular"`.
    var fontWeight: String?
    /// Foreground color as a 6-character hex string (e.g. `"FF5733"`).
    var color: String?
    /// Text alignment: `"leading"`, `"center"`, `"trailing"`.
    var alignment: String?
}

// MARK: - A2UIComponent

/// A recursive component tree node decoded from A2UI surface events.
///
/// Each case maps to a single AG-UI component type. The discriminator is
/// a `"type"` key in the JSON payload. Unknown or future component types
/// decode to `.unknown` so the application never crashes on server-driven
/// UI that was designed for a newer client version.
///
/// Conforms to `Decodable` via a custom `init(from:)` that reads the
/// `"type"` key first and then decodes the remaining fields per case.
indirect enum A2UIComponent: Decodable, Sendable {
    /// Single line or paragraph of styled text.
    case text(content: String, style: TextStyle?)
    /// Tappable button that emits `actionId` on press.
    case button(label: String, actionId: String)
    /// Vertical stack of child components.
    case vStack(children: [A2UIComponent])
    /// Horizontal stack of child components.
    case hStack(children: [A2UIComponent])
    /// Remote image loaded from `url`.
    case image(url: URL, altText: String?)
    /// Horizontal rule.
    case divider
    /// Titled card container with child components.
    case card(title: String?, children: [A2UIComponent])
    /// Ordered list of item components.
    case list(items: [A2UIComponent])
    /// Colored label badge.
    case badge(label: String, color: String?)
    /// Single-line text input bound to `bindingKey`.
    case textField(placeholder: String, bindingKey: String)
    /// Boolean toggle bound to `bindingKey`.
    case toggle(label: String, bindingKey: String, value: Bool)
    /// Drop-down selector bound to `bindingKey`.
    case select(label: String, options: [String], bindingKey: String)
    /// Determinate progress indicator.
    case progress(value: Double, total: Double)
    /// Markdown-formatted text rendered with full markup support.
    case markdown(content: String)
    /// Fixed-height vertical spacer.
    case spacer(height: CGFloat?)
    /// Chart surface — spec is raw JSON encoded as `Data`.
    case chart(spec: Data)
    /// Tabular data with column headers and string rows.
    case table(headers: [String], rows: [[String]])
    /// Fallback for any unrecognised component type.
    case unknown

    // MARK: Decodable

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""

        switch type {
        case "text":
            let content = (try? container.decode(String.self, forKey: .content)) ?? ""
            let style = try? container.decode(TextStyle.self, forKey: .style)
            self = .text(content: content, style: style)

        case "button":
            let label = (try? container.decode(String.self, forKey: .label)) ?? ""
            let actionId = (try? container.decode(String.self, forKey: .actionId)) ?? ""
            self = .button(label: label, actionId: actionId)

        case "vStack":
            let children = (try? container.decode([A2UIComponent].self, forKey: .children)) ?? []
            self = .vStack(children: children)

        case "hStack":
            let children = (try? container.decode([A2UIComponent].self, forKey: .children)) ?? []
            self = .hStack(children: children)

        case "image":
            let urlStr = (try? container.decode(String.self, forKey: .url)) ?? ""
            let url = URL(string: urlStr) ?? URL(string: "about:blank")!
            let altText = try? container.decode(String.self, forKey: .altText)
            self = .image(url: url, altText: altText)

        case "divider":
            self = .divider

        case "card":
            let title = try? container.decode(String.self, forKey: .title)
            let children = (try? container.decode([A2UIComponent].self, forKey: .children)) ?? []
            self = .card(title: title, children: children)

        case "list":
            let items = (try? container.decode([A2UIComponent].self, forKey: .items)) ?? []
            self = .list(items: items)

        case "badge":
            let label = (try? container.decode(String.self, forKey: .label)) ?? ""
            let color = try? container.decode(String.self, forKey: .color)
            self = .badge(label: label, color: color)

        case "textField":
            let placeholder = (try? container.decode(String.self, forKey: .placeholder)) ?? ""
            let bindingKey = (try? container.decode(String.self, forKey: .bindingKey)) ?? ""
            self = .textField(placeholder: placeholder, bindingKey: bindingKey)

        case "toggle":
            let label = (try? container.decode(String.self, forKey: .label)) ?? ""
            let bindingKey = (try? container.decode(String.self, forKey: .bindingKey)) ?? ""
            let value = (try? container.decode(Bool.self, forKey: .value)) ?? false
            self = .toggle(label: label, bindingKey: bindingKey, value: value)

        case "select":
            let label = (try? container.decode(String.self, forKey: .label)) ?? ""
            let options = (try? container.decode([String].self, forKey: .options)) ?? []
            let bindingKey = (try? container.decode(String.self, forKey: .bindingKey)) ?? ""
            self = .select(label: label, options: options, bindingKey: bindingKey)

        case "progress":
            let value = (try? container.decode(Double.self, forKey: .value)) ?? 0
            let total = (try? container.decode(Double.self, forKey: .total)) ?? 1
            self = .progress(value: value, total: total)

        case "markdown":
            let content = (try? container.decode(String.self, forKey: .content)) ?? ""
            self = .markdown(content: content)

        case "spacer":
            let height = try? container.decode(CGFloat.self, forKey: .height)
            self = .spacer(height: height)

        case "chart":
            if let spec = try? container.decode(JSONPayload.self, forKey: .spec),
               let specData = try? JSONEncoder().encode(spec) {
                self = .chart(spec: specData)
            } else {
                self = .chart(spec: Data())
            }

        case "table":
            let headers = (try? container.decode([String].self, forKey: .headers)) ?? []
            let rows = (try? container.decode([[String]].self, forKey: .rows)) ?? []
            self = .table(headers: headers, rows: rows)

        default:
            self = .unknown
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, content, style, label, actionId, children, url, altText
        case title, items, color, placeholder, bindingKey, value, options
        case total, height, spec, headers, rows
    }
}

// MARK: - JSONPayload (private chart spec helper)

/// Arbitrary JSON value type used only to round-trip chart spec data through `Codable`.
private indirect enum JSONPayload: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONPayload])
    case object([String: JSONPayload])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if (try? c.decodeNil()) == true { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Double.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([String: JSONPayload].self) { self = .object(v); return }
        if let v = try? c.decode([JSONPayload].self) { self = .array(v); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }
}
