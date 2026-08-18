/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType, BaseEvent } from "@ag-ui/client";
import {
  MCPAppsMiddleware,
  MCPClientConfig,
  ProxiedMCPRequest,
  MCPAppsActivityType,
  getServerHash,
} from "../src/index";
import {
  MockAgent,
  AsyncMockAgent,
  ErrorMockAgent,
  createRunAgentInput,
  createRunStartedEvent,
  createRunFinishedEvent,
  createTextMessageStartEvent,
  createTextMessageContentEvent,
  createTextMessageEndEvent,
  createMCPToolWithUI,
  createMCPToolWithoutUI,
  createMCPToolWithEmptyMeta,
  createAssistantMessageWithToolCalls,
  createToolResultMessage,
  createAGUITool,
  collectEvents,
  createMCPToolCallResult,
} from "./test-utils";

// Create mock functions that will be referenced in the mock factory
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockReadResource = vi.fn();
const mockNotification = vi.fn();
const mockPing = vi.fn();

// Track Client constructor calls
const mockClientConstructorCalls: Array<{
  clientInfo: unknown;
  options: unknown;
}> = [];

// Track transport constructor calls
const mockSSETransportCalls: URL[] = [];
const mockHTTPTransportCalls: URL[] = [];
const mockSSETransportOpts: any[] = [];
const mockHTTPTransportOpts: any[] = [];

// Mock the MCP SDK modules - using factory that returns a function returning our mock
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = mockConnect;
      close = mockClose;
      listTools = mockListTools;
      callTool = mockCallTool;
      readResource = mockReadResource;
      notification = mockNotification;
      ping = mockPing;

      constructor(clientInfo: unknown, options: unknown) {
        mockClientConstructorCalls.push({ clientInfo, options });
      }
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSEClientTransport {
    type = "sse";
    constructor(url: URL, options?: unknown) {
      mockSSETransportCalls.push(url);
      mockSSETransportOpts.push(options);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    type = "http";
    constructor(url: URL, options?: unknown) {
      mockHTTPTransportCalls.push(url);
      mockHTTPTransportOpts.push(options);
    }
  },
}));

// Mock crypto.randomUUID but keep createHash real
vi.mock("crypto", async () => {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  return {
    ...actual,
    randomUUID: vi.fn(
      () => `mock-uuid-${Math.random().toString(36).substr(2, 9)}`,
    ),
  };
});

describe("MCPAppsMiddleware", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Clear constructor calls tracking
    mockClientConstructorCalls.length = 0;
    mockSSETransportCalls.length = 0;
    mockHTTPTransportCalls.length = 0;
    mockSSETransportOpts.length = 0;
    mockHTTPTransportOpts.length = 0;

    // Set default mock implementations
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [] });
    mockReadResource.mockResolvedValue({ contents: [] });
    mockNotification.mockResolvedValue(undefined);
    mockPing.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =============================================================================
  // 1. Constructor & Configuration Tests
  // =============================================================================
  describe("Constructor & Configuration", () => {
    it("creates instance with empty config", () => {
      const middleware = new MCPAppsMiddleware();
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with empty object config", () => {
      const middleware = new MCPAppsMiddleware({});
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with HTTP server config", () => {
      const config = {
        mcpServers: [{ type: "http" as const, url: "http://localhost:3000" }],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with SSE server config", () => {
      const config = {
        mcpServers: [
          { type: "sse" as const, url: "http://localhost:3000/sse" },
        ],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with SSE server config including headers", () => {
      const config = {
        mcpServers: [
          {
            type: "sse" as const,
            url: "http://localhost:3000/sse",
            headers: { Authorization: "Bearer token" },
          },
        ],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with multiple server configs", () => {
      const config = {
        mcpServers: [
          { type: "http" as const, url: "http://localhost:3001" },
          { type: "sse" as const, url: "http://localhost:3002/sse" },
        ],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });
  });

  // =============================================================================
  // 2. Pass-Through Behavior (No MCP Servers)
  // =============================================================================
  describe("Pass-Through Behavior (No MCP Servers)", () => {
    it("passes through when mcpServers is empty array", async () => {
      const middleware = new MCPAppsMiddleware({ mcpServers: [] });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[1].type).toBe(EventType.RUN_FINISHED);
    });

    it("passes through when mcpServers is undefined", async () => {
      const middleware = new MCPAppsMiddleware({});
      const agent = new MockAgent([
        createRunStartedEvent(),
        createTextMessageStartEvent(),
        createTextMessageContentEvent(),
        createTextMessageEndEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("events flow through unchanged when no servers configured", async () => {
      const middleware = new MCPAppsMiddleware();
      const inputEvents = [
        createRunStartedEvent("run-1", "thread-1"),
        createTextMessageStartEvent("msg-1"),
        createTextMessageContentEvent("msg-1", "Hello World"),
        createTextMessageEndEvent("msg-1"),
        createRunFinishedEvent("run-1", "thread-1", { success: true }),
      ];
      const agent = new MockAgent(inputEvents);

      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      // The middleware uses runNextWithState which transforms chunks
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
    });

    it("observable completes correctly with no servers", async () => {
      const middleware = new MCPAppsMiddleware();
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      let completed = false;
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          complete: () => {
            completed = true;
            resolve();
          },
        });
      });

      expect(completed).toBe(true);
    });

    it("error propagation works with no servers", async () => {
      const middleware = new MCPAppsMiddleware();
      const testError = new Error("Test error");
      const agent = new ErrorMockAgent(testError);

      let caughtError: Error | null = null;
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          error: (err) => {
            caughtError = err;
            resolve();
          },
          complete: () => resolve(),
        });
      });

      expect(caughtError).toBe(testError);
    });
  });

  // =============================================================================
  // 3. Tool Discovery Tests
  // =============================================================================
  describe("Tool Discovery", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };
    const sseServerConfig: MCPClientConfig = {
      type: "sse",
      url: "http://localhost:3001/sse",
    };

    it("connects to MCP server with correct capabilities", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockClientConstructorCalls).toHaveLength(1);
      expect(mockClientConstructorCalls[0].clientInfo).toEqual({
        name: "mcp-apps-middleware",
        version: "1.0.0",
      });
      expect(mockClientConstructorCalls[0].options).toMatchObject({
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html+mcp"],
            },
          },
        },
      });
    });

    it("calls listTools on connected client", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockConnect).toHaveBeenCalled();
      expect(mockListTools).toHaveBeenCalled();
    });

    it("filters tools by ui/resourceUri presence", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          createMCPToolWithUI("ui-tool", "ui://server/dashboard"),
          createMCPToolWithoutUI("non-ui-tool"),
          createMCPToolWithEmptyMeta("meta-but-no-ui"),
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      // Agent should receive enhanced input with only the UI tool
      expect(agent.runCalls).toHaveLength(1);
      const enhancedTools = agent.runCalls[0].tools;
      expect(enhancedTools).toHaveLength(1);
      expect(enhancedTools[0].name).toBe("ui-tool");
    });

    it("converts MCP tools to AG-UI Tool format correctly", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "test-tool",
            description: "Test tool description",
            inputSchema: {
              type: "object",
              properties: { foo: { type: "string" } },
            },
            _meta: { "ui/resourceUri": "ui://server/test" },
          },
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      const enhancedTools = agent.runCalls[0].tools;
      expect(enhancedTools[0].name).toBe("test-tool");
      expect(enhancedTools[0].description).toContain("Test tool description");
      expect(enhancedTools[0].parameters).toEqual({
        type: "object",
        properties: { foo: { type: "string" } },
      });
    });

    it("stores ui/resourceUri in description", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          createMCPToolWithUI(
            "ui-tool",
            "ui://server/dashboard",
            "Original description",
          ),
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      const enhancedTools = agent.runCalls[0].tools;
      expect(enhancedTools[0].description).toContain("Original description");
      expect(enhancedTools[0].description).toContain(
        "[UI Resource: ui://server/dashboard]",
      );
    });

    it("handles tools without _meta", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithoutUI("no-meta-tool")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      // No UI tools should be added
      expect(agent.runCalls[0].tools).toHaveLength(0);
    });

    it("handles empty tools list from server", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(agent.runCalls[0].tools).toHaveLength(0);
    });

    it("handles server connection failures gracefully", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockConnect.mockRejectedValue(new Error("Connection failed"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      // Should not throw, should continue
      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch tools from MCP server"),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });

    it("closes client connection after fetching tools", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockClose).toHaveBeenCalled();
    });

    it("works with HTTP transport", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "http", url: "http://localhost:3000" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockHTTPTransportCalls).toHaveLength(1);
      expect(mockHTTPTransportCalls[0].toString()).toBe(
        "http://localhost:3000/",
      );
    });

    it("works with SSE transport", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "sse", url: "http://localhost:3001/sse" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockSSETransportCalls).toHaveLength(1);
      expect(mockSSETransportCalls[0].toString()).toBe(
        "http://localhost:3001/sse",
      );
    });

    it("forwards configured headers to the HTTP transport (#1862)", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const headers = { Authorization: "Bearer secret-token" };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "http", url: "http://localhost:3000", headers }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockHTTPTransportCalls).toHaveLength(1);
      expect(mockHTTPTransportOpts[0]).toEqual({ requestInit: { headers } });
    });

    it("forwards configured headers to the SSE transport (#1862)", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const headers = { Authorization: "Bearer secret-token" };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [
          { type: "sse", url: "http://localhost:3001/sse", headers },
        ],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockSSETransportCalls).toHaveLength(1);
      expect(mockSSETransportOpts[0]).toEqual({ requestInit: { headers } });
    });

    it("passes no transport options when no headers are configured", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "http", url: "http://localhost:3000" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockHTTPTransportCalls).toHaveLength(1);
      expect(mockHTTPTransportOpts[0]).toBeUndefined();
    });

    it("getServerHash distinguishes HTTP servers that differ only by headers (#1862)", () => {
      const base = { type: "http" as const, url: "http://localhost:3000" };
      const withAuth = { ...base, headers: { Authorization: "Bearer a" } };
      const withOtherAuth = { ...base, headers: { Authorization: "Bearer b" } };

      expect(getServerHash(base)).not.toBe(getServerHash(withAuth));
      expect(getServerHash(withAuth)).not.toBe(getServerHash(withOtherAuth));
    });

    it("aggregates tools from multiple servers", async () => {
      // We need to track which server each call is for
      let callCount = 0;
      mockListTools.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            tools: [createMCPToolWithUI("tool-1", "ui://server1/tool1")],
          });
        }
        return Promise.resolve({
          tools: [createMCPToolWithUI("tool-2", "ui://server2/tool2")],
        });
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig, sseServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(agent.runCalls[0].tools).toHaveLength(2);
      expect(agent.runCalls[0].tools.map((t) => t.name)).toContain("tool-1");
      expect(agent.runCalls[0].tools.map((t) => t.name)).toContain("tool-2");
    });
  });

  // =============================================================================
  // 4. Tool Injection Tests
  // =============================================================================
  describe("Tool Injection", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("merges UI tools with existing input tools", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/dashboard")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const existingTool = createAGUITool("existing-tool");
      const input = createRunAgentInput({ tools: [existingTool] });

      await collectEvents(middleware.run(input, agent));

      expect(agent.runCalls[0].tools).toHaveLength(2);
      expect(agent.runCalls[0].tools[0].name).toBe("existing-tool");
      expect(agent.runCalls[0].tools[1].name).toBe("ui-tool");
    });

    it("preserves original input tools", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/dashboard")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const originalTools = [
        createAGUITool("tool-a", "Description A"),
        createAGUITool("tool-b", "Description B"),
      ];
      const input = createRunAgentInput({ tools: originalTools });

      await collectEvents(middleware.run(input, agent));

      const resultTools = agent.runCalls[0].tools;
      expect(resultTools[0]).toEqual(originalTools[0]);
      expect(resultTools[1]).toEqual(originalTools[1]);
    });

    it("passes enhanced input to next agent", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/dashboard")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({
        threadId: "custom-thread",
        runId: "custom-run",
        state: { key: "value" },
      });

      await collectEvents(middleware.run(input, agent));

      expect(agent.runCalls[0].threadId).toBe("custom-thread");
      expect(agent.runCalls[0].runId).toBe("custom-run");
      expect(agent.runCalls[0].state).toEqual({ key: "value" });
      expect(agent.runCalls[0].tools.length).toBe(1);
    });
  });

  // =============================================================================
  // 5. Event Stream Processing Tests
  // =============================================================================
  describe("Event Stream Processing", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("emits non-RUN_FINISHED events immediately", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createTextMessageStartEvent(),
        createTextMessageContentEvent(),
        createTextMessageEndEvent(),
        createRunFinishedEvent(),
      ]);

      const receivedEvents: BaseEvent[] = [];
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          next: (event) => receivedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // First event should be RUN_STARTED
      expect(receivedEvents[0].type).toBe(EventType.RUN_STARTED);
      // Last event should be RUN_FINISHED
      expect(receivedEvents[receivedEvents.length - 1].type).toBe(
        EventType.RUN_FINISHED,
      );
    });

    it("holds back RUN_FINISHED event until stream ends", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new AsyncMockAgent(
        [createRunStartedEvent(), createRunFinishedEvent()],
        10,
      );

      const receivedEvents: BaseEvent[] = [];
      let finishedReceived = false;

      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          next: (event) => {
            receivedEvents.push(event);
            if (event.type === EventType.RUN_FINISHED) {
              finishedReceived = true;
            }
          },
          complete: () => resolve(),
        });
      });

      expect(finishedReceived).toBe(true);
      expect(receivedEvents[receivedEvents.length - 1].type).toBe(
        EventType.RUN_FINISHED,
      );
    });

    it("handles error events correctly", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const testError = new Error("Stream error");
      const agent = new ErrorMockAgent(testError);

      let caughtError: Error | null = null;
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          error: (err) => {
            caughtError = err;
            resolve();
          },
          complete: () => resolve(),
        });
      });

      expect(caughtError).toBe(testError);
    });

    it("subscription cleanup works", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new AsyncMockAgent(
        [
          createRunStartedEvent(),
          createTextMessageStartEvent(),
          createTextMessageContentEvent(),
          createRunFinishedEvent(),
        ],
        50,
      );

      let eventCount = 0;
      const subscription = middleware
        .run(createRunAgentInput(), agent)
        .subscribe({
          next: () => {
            eventCount++;
            if (eventCount === 2) {
              subscription.unsubscribe();
            }
          },
        });

      // Wait a bit to ensure no more events are received after unsubscribe
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(eventCount).toBe(2);
    });
  });

  // =============================================================================
  // 6. Pending Tool Call Detection Tests
  // =============================================================================
  describe("Pending Tool Call Detection", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("processes pending UI tool calls on stream completion", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Weather result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      // Create an assistant message with a tool call that won't have a result
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather", args: { city: "London" }, id: "tc-1" },
      ]);

      // Agent emits events but doesn't emit a tool result
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      // Set up input with the assistant message containing the tool call
      const input = createRunAgentInput({
        messages: [assistantMsg],
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should have emitted TOOL_CALL_RESULT and ACTIVITY_SNAPSHOT events
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      const activityEvents = events.filter(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );

      expect(toolResultEvents.length).toBe(1);
      expect(activityEvents.length).toBe(1);
    });

    it("identifies resolved tool calls (role: tool messages)", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      // Create assistant message with tool call AND a tool result message
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather", args: { city: "London" }, id: "tc-1" },
      ]);
      const toolResultMsg = createToolResultMessage("tc-1", "Already resolved");

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({
        messages: [assistantMsg, toolResultMsg],
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should NOT emit additional TOOL_CALL_RESULT since it's already resolved
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(0);
    });

    it("handles empty message arrays", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/tool")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({ messages: [] });
      const events = await collectEvents(middleware.run(input, agent));

      // Should complete without errors
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("handles messages without tool calls", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/tool")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({
        messages: [
          { id: "msg-1", role: "user", content: "Hello" },
          { id: "msg-2", role: "assistant", content: "Hi there" },
        ],
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should complete without emitting tool results
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(0);
    });

    it("handles multiple tool calls per message", async () => {
      const uiTool1 = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      const uiTool2 = createMCPToolWithUI("ui-stocks", "ui://stocks/chart");
      mockListTools.mockResolvedValue({ tools: [uiTool1, uiTool2] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather", args: {}, id: "tc-1" },
        { name: "ui-stocks", args: {}, id: "tc-2" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(2);
    });
  });

  // =============================================================================
  // 7. Tool Execution Tests
  // =============================================================================
  describe("Tool Execution", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("passes correct tool name and arguments", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Sunny" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        {
          name: "ui-weather",
          args: { city: "London", units: "metric" },
          id: "tc-1",
        },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      await collectEvents(middleware.run(input, agent));

      expect(mockCallTool).toHaveBeenCalledWith({
        name: "ui-weather",
        arguments: { city: "London", units: "metric" },
      });
    });

    it("returns raw MCP result", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      const mcpResult = createMCPToolCallResult([
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ]);
      mockCallTool.mockResolvedValue(mcpResult);

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.result).toEqual(mcpResult);
    });

    it("handles tool execution errors", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockRejectedValue(new Error("Execution failed"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      // Should emit error tool result
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(1);
      expect((toolResultEvents[0] as any).content).toContain("error");

      consoleErrorSpy.mockRestore();
    });

    it("closes connection after execution", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      await collectEvents(middleware.run(input, agent));

      // close should be called multiple times (once for listTools, once for callTool)
      expect(mockClose).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // 8. Activity Snapshot ResourceUri Tests
  // =============================================================================
  describe("Activity Snapshot ResourceUri", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("includes resourceUri in activity snapshot instead of resource content", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/dashboard");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/dashboard",
      );
      // Should NOT have resource content (frontend fetches it)
      expect((activityEvent as any).content.resource).toBeUndefined();
    });

    it("does not call readResource during tool execution", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      await collectEvents(middleware.run(input, agent));

      // readResource should NOT be called during tool execution
      // (frontend will fetch via proxied request)
      expect(mockReadResource).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // 9. Tool Result Events Tests
  // =============================================================================
  describe("Tool Result Events", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("emits TOOL_CALL_RESULT event with correct toolCallId", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "specific-tc-id" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvent = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect((toolResultEvent as any).toolCallId).toBe("specific-tc-id");
    });

    it("extracts text content from MCP result", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvent = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect((toolResultEvent as any).content).toBe("Line 1\nLine 2");
    });

    it("falls back to JSON.stringify for non-text content", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "image", data: "base64data" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvent = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect((toolResultEvent as any).content).toContain("image");
      expect((toolResultEvent as any).content).toContain("base64data");
    });

    it("emits ACTIVITY_SNAPSHOT with MCP result and resourceUri", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      const mcpResult = createMCPToolCallResult([
        { type: "text", text: "Result" },
      ]);
      mockCallTool.mockResolvedValue(mcpResult);

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.result).toEqual(mcpResult);
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/tool",
      );
      // Should NOT have resource content
      expect((activityEvent as any).content.resource).toBeUndefined();
    });

    it("sets activityType to mcp-apps", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect((activityEvent as any).activityType).toBe(MCPAppsActivityType);
      expect((activityEvent as any).activityType).toBe("mcp-apps");
    });

    it("sets replace: true on activity snapshot", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect((activityEvent as any).replace).toBe(true);
    });
  });

  // =============================================================================
  // 10. MCPAppsActivityType Export Tests
  // =============================================================================
  describe("MCPAppsActivityType Export", () => {
    it("exports MCPAppsActivityType constant", () => {
      expect(MCPAppsActivityType).toBeDefined();
      expect(MCPAppsActivityType).toBe("mcp-apps");
    });
  });

  // =============================================================================
  // 11. Proxied MCP Request Mode Tests
  // =============================================================================
  describe("Proxied MCP Request Mode", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("detects proxied request in forwardedProps", async () => {
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should bypass normal agent flow (agent.run should not be called with our input)
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("emits RUN_STARTED event", async () => {
      mockPing.mockResolvedValue({});

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        runId: "proxy-run",
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect((events[0] as any).runId).toBe("proxy-run");
    });

    it("emits RUN_FINISHED with result on success", async () => {
      const pingResult = { timestamp: Date.now() };
      mockPing.mockResolvedValue(pingResult);

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect(finishedEvent).toBeDefined();
      expect((finishedEvent as any).result).toEqual(pingResult);
    });

    it("emits RUN_FINISHED with error on failure", async () => {
      mockConnect.mockRejectedValue(new Error("Connection refused"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect((finishedEvent as any).result.error).toContain(
        "Connection refused",
      );
    });

    it("emits error for unknown serverHash", async () => {
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: "unknown-server-hash",
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect((finishedEvent as any).result.error).toContain("Unknown server");
    });

    it("bypasses normal agent flow", async () => {
      mockPing.mockResolvedValue({});

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "http", url: "http://localhost:3001" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash({
          type: "http",
          url: "http://localhost:3001",
        }),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      await collectEvents(middleware.run(input, agent));

      // Agent's run should not have been called
      expect(agent.runCalls).toHaveLength(0);
    });
  });

  // =============================================================================
  // 12. Server Hash Tests
  // =============================================================================
  describe("Server Hash", () => {
    it("generates consistent serverHash for same config", () => {
      const config: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const id1 = getServerHash(config);
      const id2 = getServerHash(config);
      expect(id1).toBe(id2);
    });

    it("generates different serverHashes for different URLs", () => {
      const config1: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const config2: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3001",
      };
      expect(getServerHash(config1)).not.toBe(getServerHash(config2));
    });

    it("generates different serverHashes for different types", () => {
      const config1: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const config2: MCPClientConfig = {
        type: "sse",
        url: "http://localhost:3000",
      };
      expect(getServerHash(config1)).not.toBe(getServerHash(config2));
    });

    it("generates different serverHashes for SSE configs with different headers", () => {
      const config1: MCPClientConfig = {
        type: "sse",
        url: "http://localhost:3000",
        headers: { Authorization: "token1" },
      };
      const config2: MCPClientConfig = {
        type: "sse",
        url: "http://localhost:3000",
        headers: { Authorization: "token2" },
      };
      expect(getServerHash(config1)).not.toBe(getServerHash(config2));
    });

    it("includes serverHash in ACTIVITY_SNAPSHOT content", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.serverHash).toBe(
        getServerHash(httpServerConfig),
      );
      // Should NOT have serverUrl or serverType or old serverId
      expect((activityEvent as any).content.serverUrl).toBeUndefined();
      expect((activityEvent as any).content.serverType).toBeUndefined();
      expect((activityEvent as any).content.serverId).toBeUndefined();
    });
  });

  // =============================================================================
  // 13. Server ID Tests
  // =============================================================================
  describe("Server ID", () => {
    it("includes serverId in ACTIVITY_SNAPSHOT when configured", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-weather-server",
      };
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.serverId).toBe("my-weather-server");
    });

    it("serverId is undefined in ACTIVITY_SNAPSHOT when not configured", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.serverId).toBeUndefined();
    });

    it("looks up server by serverId in proxied requests", async () => {
      mockPing.mockResolvedValue({});

      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-server",
      };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: "wrong-hash", // Wrong hash, but serverId should work
        serverId: "my-server",
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      // Should succeed because serverId lookup worked
      expect((finishedEvent as any).result.error).toBeUndefined();
    });

    it("falls back to serverHash when serverId not found", async () => {
      mockPing.mockResolvedValue({});

      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-server",
      };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        serverId: "non-existent-server", // Wrong name, should fall back to hash
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      // Should succeed because serverHash fallback worked
      expect((finishedEvent as any).result.error).toBeUndefined();
    });

    it("returns error when neither serverId nor serverHash match", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-server",
      };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: "wrong-hash",
        serverId: "wrong-name",
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect((finishedEvent as any).result.error).toContain("Unknown server");
    });
  });
});
