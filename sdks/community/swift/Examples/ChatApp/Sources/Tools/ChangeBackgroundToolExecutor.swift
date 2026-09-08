// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import AGUITools
import Foundation

// MARK: - ChangeBackgroundToolExecutor

/// Client-side tool executor that updates the chat background color.
///
/// Registered with the `StatefulAgUiAgent`'s tool registry so the agent can
/// call `change_background` locally instead of routing through a server round-trip.
///
/// Accepts `"color"`, `"hex"`, or `"background"` keys for the color value.
/// Pass `"reset": true` to restore the default background.
actor ChangeBackgroundToolExecutor: ToolExecutor {

    // MARK: - Tool definition

    nonisolated let tool: Tool = Tool(
        name: "change_background",
        description: "Changes the chat background color. Pass reset: true to restore the default.",
        parameters: Data("""
        {
            "type": "object",
            "properties": {
                "color": {
                    "type": "string",
                    "description": "Hex color string (#RRGGBB / #RRGGBBAA) or CSS gradient"
                },
                "description": {
                    "type": "string",
                    "description": "Human-readable description of the background"
                },
                "reset": {
                    "type": "boolean",
                    "description": "Set true to restore the default background"
                }
            }
        }
        """.utf8)
    )

    // MARK: - Private state

    /// Called when the agent requests a color change (`String`) or a reset (`nil`).
    private let onBackground: @Sendable (String?) async -> Void

    // MARK: - Init

    init(onBackground: @escaping @Sendable (String?) async -> Void) {
        self.onBackground = onBackground
    }

    // MARK: - ToolExecutor

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let args = context.toolCall.function.arguments

        if isReset(args) {
            await onBackground(nil)
            return .success(message: "Background reset to default")
        }

        guard let colorValue = parseColor(from: args) else {
            throw ToolExecutionError.validationFailed(
                message: "Provide a 'color' value or pass 'reset: true'"
            )
        }
        await onBackground(colorValue)
        return .success(message: "Background updated to \(colorValue)")
    }

    nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult {
        let args = toolCall.function.arguments
        guard isReset(args) || parseColor(from: args) != nil else {
            return .invalid(errors: ["Provide 'color', 'hex', 'background', or 'reset: true'"])
        }
        return .valid
    }

    // MARK: - Private helpers

    /// Returns `true` when the arguments contain `"reset": true`.
    private nonisolated func isReset(_ arguments: String) -> Bool {
        guard
            let data = arguments.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return json["reset"] as? Bool == true
    }

    /// Extracts the color value from JSON arguments.
    ///
    /// Accepts `"color"`, `"hex"`, or `"background"` keys.
    /// The value may be a hex string or a CSS gradient/color expression.
    private nonisolated func parseColor(from arguments: String) -> String? {
        guard
            let data = arguments.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json["color"] as? String
            ?? json["hex"] as? String
            ?? json["background"] as? String
    }
}
