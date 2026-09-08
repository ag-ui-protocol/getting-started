// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import AGUITools
import XCTest
@testable import AGUIAgentSDK

// MARK: - AgentBuildersTests

final class AgentBuildersTests: XCTestCase {

    private let agentURL = URL(string: "https://agent.example.com")!

    // MARK: - agentWithBearer

    func testAgentWithBearerCreatesAgUiAgent() {
        let agent = AgentBuilders.agentWithBearer(url: agentURL, token: "tok_test")
        XCTAssertNotNil(agent)
    }

    func testAgentWithBearerSetsAuthorizationHeader() {
        let agent = AgentBuilders.agentWithBearer(url: agentURL, token: "sk-secret")
        let headers = agent.config.buildHeaders()
        XCTAssertEqual(headers["Authorization"], "Bearer sk-secret")
    }

    func testAgentWithBearerStoresToken() {
        let agent = AgentBuilders.agentWithBearer(url: agentURL, token: "my-token")
        XCTAssertEqual(agent.config.bearerToken, "my-token")
    }

    // MARK: - agentWithApiKey

    func testAgentWithApiKeyCreatesAgUiAgent() {
        let agent = AgentBuilders.agentWithApiKey(url: agentURL, apiKey: "key123")
        XCTAssertNotNil(agent)
    }

    func testAgentWithApiKeyUsesDefaultHeader() {
        let agent = AgentBuilders.agentWithApiKey(url: agentURL, apiKey: "key123")
        let headers = agent.config.buildHeaders()
        XCTAssertEqual(headers["X-API-Key"], "key123")
    }

    func testAgentWithApiKeyUsesCustomHeader() {
        let agent = AgentBuilders.agentWithApiKey(url: agentURL, apiKey: "key123", header: "X-Custom-Key")
        let headers = agent.config.buildHeaders()
        XCTAssertEqual(headers["X-Custom-Key"], "key123")
        XCTAssertNil(headers["X-API-Key"])
    }

    func testAgentWithApiKeyStoresKey() {
        let agent = AgentBuilders.agentWithApiKey(url: agentURL, apiKey: "key_abc")
        XCTAssertEqual(agent.config.apiKey, "key_abc")
    }

    // MARK: - agentWithTools

    func testAgentWithToolsCreatesAgUiAgent() {
        let registry = MockToolRegistry()
        let agent = AgentBuilders.agentWithTools(url: agentURL, registry: registry)
        XCTAssertNotNil(agent)
    }

    func testAgentWithToolsSetsRegistry() {
        let registry = MockToolRegistry()
        let agent = AgentBuilders.agentWithTools(url: agentURL, registry: registry)
        XCTAssertNotNil(agent.config.toolRegistry)
    }

    // MARK: - debugAgent

    func testDebugAgentCreatesAgUiAgent() {
        let agent = AgentBuilders.debugAgent(url: agentURL)
        XCTAssertNotNil(agent)
    }

    func testDebugAgentSetsDebugFlag() {
        let agent = AgentBuilders.debugAgent(url: agentURL)
        XCTAssertTrue(agent.config.debug)
    }

    func testNonDebugAgentHasDebugFalse() {
        let agent = AgUiAgent(url: agentURL)
        XCTAssertFalse(agent.config.debug)
    }

    // MARK: - chatAgent

    func testChatAgentCreatesStatefulAgUiAgent() {
        let agent = AgentBuilders.chatAgent(url: agentURL, systemPrompt: "Be helpful.")
        XCTAssertNotNil(agent)
    }

    func testChatAgentSetsSystemPrompt() {
        let agent = AgentBuilders.chatAgent(url: agentURL, systemPrompt: "You are a pirate.")
        XCTAssertEqual(agent.config.systemPrompt, "You are a pirate.")
    }

    func testChatAgentReturnsStatefulType() {
        let agent = AgentBuilders.chatAgent(url: agentURL, systemPrompt: "Hi")
        XCTAssert(agent is StatefulAgUiAgent)
    }

    // MARK: - statefulAgent

    func testStatefulAgentCreatesStatefulAgUiAgent() {
        let agent = AgentBuilders.statefulAgent(url: agentURL, initialState: Data("{}".utf8))
        XCTAssertNotNil(agent)
    }

    func testStatefulAgentSetsInitialState() {
        let state = Data("{\"key\":\"value\"}".utf8)
        let agent = AgentBuilders.statefulAgent(url: agentURL, initialState: state)
        XCTAssertEqual(agent.config.initialState, state)
    }

    func testStatefulAgentReturnsStatefulType() {
        let agent = AgentBuilders.statefulAgent(url: agentURL, initialState: Data("{}".utf8))
        XCTAssert(agent is StatefulAgUiAgent)
    }

    // MARK: - AgUiAgentConfig.buildHeaders

    func testBuildHeadersBearerTakesEffectOverApiKey() {
        var config = AgUiAgentConfig()
        config.bearerToken = "tok"
        config.apiKey = "key"
        config.apiKeyHeader = "X-API-Key"
        let headers = config.buildHeaders()
        XCTAssertEqual(headers["Authorization"], "Bearer tok")
        XCTAssertEqual(headers["X-API-Key"], "key")
    }

    func testBuildHeadersExplicitHeadersOverrideAuth() {
        var config = AgUiAgentConfig()
        config.bearerToken = "tok"
        config.headers = ["Authorization": "Basic override"]
        let headers = config.buildHeaders()
        // Explicit headers override auth helpers
        XCTAssertEqual(headers["Authorization"], "Basic override")
    }

    func testBuildHeadersEmptyWhenNothingConfigured() {
        let config = AgUiAgentConfig()
        XCTAssertTrue(config.buildHeaders().isEmpty)
    }

    // MARK: - StatefulAgUiAgentConfig.buildHeaders

    func test_statefulConfig_buildHeaders_bearerToken() {
        var config = StatefulAgUiAgentConfig(baseURL: agentURL)
        config.bearerToken = "sk-secret"
        XCTAssertEqual(config.buildHeaders()["Authorization"], "Bearer sk-secret")
    }

    func test_statefulConfig_buildHeaders_apiKey() {
        var config = StatefulAgUiAgentConfig(baseURL: agentURL)
        config.apiKey = "my-key"
        XCTAssertEqual(config.buildHeaders()["X-API-Key"], "my-key")
    }

    func test_statefulConfig_buildHeaders_explicitHeadersOverrideAuth() {
        var config = StatefulAgUiAgentConfig(baseURL: agentURL)
        config.bearerToken = "tok"
        config.headers = ["Authorization": "Basic override"]
        XCTAssertEqual(config.buildHeaders()["Authorization"], "Basic override")
    }

    func test_statefulConfig_buildHeaders_emptyWhenNothingConfigured() {
        let config = StatefulAgUiAgentConfig(baseURL: agentURL)
        XCTAssertTrue(config.buildHeaders().isEmpty)
    }
}
