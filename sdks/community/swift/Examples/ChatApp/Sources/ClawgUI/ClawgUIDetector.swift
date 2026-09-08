// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

// MARK: - ClawgUIDetector

/// Identifies whether a URL string points to a ClawgUI enterprise gateway endpoint.
///
/// Mirrors the detection logic from the Kotlin SDK reference implementation.
/// A URL is considered a ClawgUI endpoint when its path contains `/v1/clawg-ui`.
enum ClawgUIDetector {

    /// Returns `true` when `urlString` contains the `/v1/clawg-ui` path segment.
    ///
    /// The check is case-sensitive — URL paths are case-sensitive by convention.
    static func isClawgUIEndpoint(_ urlString: String) -> Bool {
        urlString.range(
            of: #"/v1/clawg-ui"#,
            options: .regularExpression
        ) != nil
    }
}
