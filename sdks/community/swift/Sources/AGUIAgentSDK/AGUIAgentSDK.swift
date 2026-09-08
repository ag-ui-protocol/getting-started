// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUIClient
import AGUICore
import Foundation

/// AGUIAgentSDK provides high-level APIs for common agent interaction patterns.
///
/// This module offers convenient, easy-to-use APIs for building AI agent user interfaces.
/// It builds on top of AGUICore and AGUIClient to provide a streamlined developer experience.
///
/// Key Components:
/// - **AgUiAgent**: Stateless client for cases where no ongoing context is needed
/// - **StatefulAgUiAgent**: Stateful client that maintains conversation history
/// - **Builders**: Convenient builder patterns for agent configuration
public struct AGUIAgentSDK {
    /// AGUIAgentSDK version
    public static let version = "1.0.0"

    public init() {}
}
