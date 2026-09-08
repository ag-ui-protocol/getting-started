// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Strategy for handling buffer overflow.
///
/// When a bounded buffer fills up and new elements arrive, the strategy
/// determines which elements to keep and which to drop.
///
/// ## Usage
///
/// ```swift
/// let buffered = stream.buffered(limit: 100, strategy: .dropOldest)
/// ```
public enum BufferingStrategy: Sendable {
    /// Drop the oldest elements when buffer is full.
    ///
    /// This strategy keeps the most recent elements, which is useful when
    /// you want the latest state and older data can be safely discarded.
    ///
    /// **Use case**: Real-time monitoring where only current values matter.
    ///
    /// ## Example
    ///
    /// ```
    /// Buffer: [1, 2, 3, 4, 5] (limit: 5)
    /// New: 6
    /// Result: [2, 3, 4, 5, 6] // Dropped 1
    /// ```
    case dropOldest

    /// Drop the newest elements when buffer is full.
    ///
    /// This strategy preserves the oldest elements, which is useful when
    /// historical data is important and newer data can be discarded.
    ///
    /// **Use case**: Processing a queue where order matters and you want
    /// to ensure early events are handled.
    ///
    /// ## Example
    ///
    /// ```
    /// Buffer: [1, 2, 3, 4, 5] (limit: 5)
    /// New: 6
    /// Result: [1, 2, 3, 4, 5] // Dropped 6
    /// ```
    case dropNewest
}
