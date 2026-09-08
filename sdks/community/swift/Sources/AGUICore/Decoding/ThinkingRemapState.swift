// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Mutable state for the THINKING_* → REASONING_* backward-compatibility remap.
///
/// The remap needs two stable IDs per sequence:
/// - `currentReasoningId`: shared by `THINKING_START` and `THINKING_END`
/// - `currentMessageId`: shared by `THINKING_TEXT_MESSAGE_START`, `_CONTENT`, and `_END`
///
/// Stored as a reference type inside the `Sendable` `AGUIEventDecoder` struct.
/// `AGUIEventDecoder` must be used serially (SSE streams guarantee this), so no
/// additional synchronization is required.
final class ThinkingRemapState: @unchecked Sendable {
    var currentReasoningId: String?
    var currentMessageId: String?
}
