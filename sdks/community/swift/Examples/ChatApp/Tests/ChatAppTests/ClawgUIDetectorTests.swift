// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import ChatApp

final class ClawgUIDetectorTests: XCTestCase {

    // MARK: - Positive matches

    func test_matchesStandardClawgUIPath() {
        XCTAssertTrue(ClawgUIDetector.isClawgUIEndpoint("https://gateway.enterprise.com/v1/clawg-ui"))
    }

    func test_matchesClawgUIWithSubpath() {
        XCTAssertTrue(ClawgUIDetector.isClawgUIEndpoint("https://gateway.enterprise.com/v1/clawg-ui/chat"))
    }

    func test_matchesClawgUIOnLocalhost() {
        XCTAssertTrue(ClawgUIDetector.isClawgUIEndpoint("http://localhost:8080/v1/clawg-ui"))
    }

    func test_matchesClawgUIWithPort() {
        XCTAssertTrue(ClawgUIDetector.isClawgUIEndpoint("https://api.example.com:9443/v1/clawg-ui/agentic_chat"))
    }

    // MARK: - Negative matches

    func test_rejectsStandardAPIURL() {
        XCTAssertFalse(ClawgUIDetector.isClawgUIEndpoint("https://api.openai.com/v1/chat/completions"))
    }

    func test_rejectsRegularAgentURL() {
        XCTAssertFalse(ClawgUIDetector.isClawgUIEndpoint("https://my-agent.example.com/run"))
    }

    func test_rejectsEmptyString() {
        XCTAssertFalse(ClawgUIDetector.isClawgUIEndpoint(""))
    }

    func test_rejectsNearMissWithoutClawgUI() {
        XCTAssertFalse(ClawgUIDetector.isClawgUIEndpoint("https://example.com/v1/clawg"))
    }

    func test_rejectsURLWithClawgUIInHost_notPath() {
        // Only path segment /v1/clawg-ui matches — not host name
        XCTAssertFalse(ClawgUIDetector.isClawgUIEndpoint("https://clawg-ui.enterprise.com/v1/chat"))
    }

    func test_isCaseSensitive() {
        // URL paths are case-sensitive; uppercase should not match
        XCTAssertFalse(ClawgUIDetector.isClawgUIEndpoint("https://example.com/V1/CLAWG-UI"))
    }
}
