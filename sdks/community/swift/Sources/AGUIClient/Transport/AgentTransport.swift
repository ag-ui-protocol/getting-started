// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

public protocol AgentTransport: Sendable {
    func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error>
}
