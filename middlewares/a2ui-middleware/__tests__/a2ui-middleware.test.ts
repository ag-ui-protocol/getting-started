import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  Tool,
  AssistantMessage,
  ToolMessage,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";

import {
  A2UIMiddleware,
  A2UIActivityType,
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  RENDER_A2UI_TOOL_NAME,
  LOG_A2UI_EVENT_TOOL_NAME,
  extractSurfaceIds,
  tryParseA2UIOperations,
} from "../src/index";

/**
 * Mock Agent for testing middleware
 */
class MockAgent extends AbstractAgent {
  private events: BaseEvent[];
  public runCalls: RunAgentInput[] = [];

  constructor(events: BaseEvent[] = []) {
    super();
    this.events = events;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    return new Observable((subscriber) => {
      for (const event of this.events) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  setEvents(events: BaseEvent[]): void {
    this.events = events;
  }
}

/**
 * Create a basic RunAgentInput for testing
 */
function createRunAgentInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "test-thread",
    runId: "test-run",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
    ...overrides,
  };
}

/**
 * Collect all events from an Observable
 */
async function collectEvents(observable: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(observable.pipe(toArray()));
}

// OSS-162: the a2ui-surface activity now also carries pre-paint lifecycle
// snapshots (`content.status` = "building" | "retrying" | "failed", no
// a2ui_operations). Tests that assert PAINT behaviour filter to snapshots that
// actually carry operations.
const isPaint = (e: BaseEvent): boolean =>
  e.type === EventType.ACTIVITY_SNAPSHOT && Array.isArray((e as any).content?.a2ui_operations);

describe("A2UIMiddleware", () => {
  describe("tool injection", () => {
    it("should inject render_a2ui tool when injectA2UITool is true", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: true });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls).toHaveLength(1);
      const tools = mockAgent.runCalls[0].tools;
      expect(tools.some((t) => t.name === RENDER_A2UI_TOOL_NAME)).toBe(true);
      // The flag is forwarded so downstream (e.g. LangGraph) can surface it into state.
      expect(mockAgent.runCalls[0].forwardedProps?.injectA2UITool).toBe(true);
    });

    it("should forward a custom injectA2UITool tool name as the flag", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: "custom_render" });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      const tools = mockAgent.runCalls[0].tools;
      expect(tools.some((t) => t.name === "custom_render")).toBe(true);
      expect(mockAgent.runCalls[0].forwardedProps?.injectA2UITool).toBe("custom_render");
    });

    it("should not inject tool by default", async () => {
      const middleware = new A2UIMiddleware();
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls).toHaveLength(1);
      const tools = mockAgent.runCalls[0].tools;
      expect(tools.some((t) => t.name === RENDER_A2UI_TOOL_NAME)).toBe(false);
      // No injection -> flag must not be forwarded.
      expect(mockAgent.runCalls[0].forwardedProps?.injectA2UITool).toBeUndefined();
    });

    it("should not duplicate tool if already present", async () => {
      const middleware = new A2UIMiddleware({ injectA2UITool: true });
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const existingTool: Tool = {
        name: RENDER_A2UI_TOOL_NAME,
        description: "Existing tool",
        parameters: {},
      };

      const input = createRunAgentInput({ tools: [existingTool] });
      await collectEvents(middleware.run(input, mockAgent));

      const tools = mockAgent.runCalls[0].tools;
      const matchingTools = tools.filter((t) => t.name === RENDER_A2UI_TOOL_NAME);
      expect(matchingTools).toHaveLength(1);
    });
  });

  describe("user action processing", () => {
    it("should prepend synthetic messages for user action", async () => {
      const middleware = new A2UIMiddleware();
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput({
        forwardedProps: {
          a2uiAction: {
            userAction: {
              name: "book_restaurant",
              surfaceId: "restaurant-card",
              sourceComponentId: "book-btn",
              context: { restaurantName: "Xi'an Famous Foods" },
            },
          },
        },
      });

      await collectEvents(middleware.run(input, mockAgent));

      const messages = mockAgent.runCalls[0].messages;
      expect(messages.length).toBe(2);

      // First message should be assistant with tool call
      const assistantMsg = messages[0] as AssistantMessage;
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.toolCalls).toHaveLength(1);
      expect(assistantMsg.toolCalls![0].function.name).toBe(LOG_A2UI_EVENT_TOOL_NAME);

      // Second message should be tool result
      const toolMsg = messages[1] as ToolMessage;
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.content).toContain("book_restaurant");
      expect(toolMsg.content).toContain("restaurant-card");
    });

    it("should not modify messages when no user action present", async () => {
      const middleware = new A2UIMiddleware();
      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      await collectEvents(middleware.run(input, mockAgent));

      expect(mockAgent.runCalls[0].messages).toHaveLength(0);
    });
  });

  describe("tool call interception", () => {
    it("should emit ACTIVITY_SNAPSHOT for render_a2ui via streaming and TOOL_CALL_RESULT at RUN_FINISHED", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-123";

      // render_a2ui uses structured args: surfaceId, components, items
      const structuredArgs = JSON.stringify({
        surfaceId: "test-surface",
        catalogId: "basic",
        components: [
          { id: "root", component: "Text", text: "Hello" },
        ],
        items: [],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: structuredArgs,
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Streaming handler should have emitted a painted ACTIVITY_SNAPSHOT during TOOL_CALL_ARGS
      const activityEvent = events.find(isPaint);
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).activityType).toBe(A2UIActivityType);
      // Should have createSurface + updateComponents (first emission)
      const ops = (activityEvent as any).content.a2ui_operations;
      expect(ops.length).toBeGreaterThanOrEqual(2);

      // Synthetic TOOL_CALL_RESULT emitted at RUN_FINISHED
      const resultEvent = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(resultEvent).toBeDefined();
      expect((resultEvent as any).toolCallId).toBe(toolCallId);
    });

    it("should pass through events for other tools", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-other";

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "other_tool",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: '{"arg": "value"}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Should NOT have ACTIVITY_SNAPSHOT for other tools
      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT
      );
      expect(activityEvent).toBeUndefined();

      // Should NOT have TOOL_CALL_RESULT (middleware doesn't emit for other tools)
      const resultEvent = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(resultEvent).toBeUndefined();
    });

    it("should handle streaming args deltas for render_a2ui", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-streaming";

      // Structured args split into multiple deltas
      const fullArgs = JSON.stringify({
        surfaceId: "s1",
        catalogId: "basic",
        components: [
          { id: "root", component: "Text", text: "Hello" },
        ],
        items: [],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(0, 20),
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(20, 50),
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(50),
        },
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      const activitySnapshots = events.filter(isPaint);
      expect(activitySnapshots.length).toBeGreaterThanOrEqual(1);

      // createSurface is emitted early — the first snapshot creates the surface
      // (so the frontend can paint a skeleton before components finish).
      const firstOps = (activitySnapshots[0] as any).content.a2ui_operations;
      expect(firstOps.some((op: any) => op.createSurface)).toBe(true);

      // By the final snapshot, components have landed (createSurface + updateComponents).
      const lastOps = (activitySnapshots[activitySnapshots.length - 1] as any).content
        .a2ui_operations;
      expect(lastOps.some((op: any) => op.updateComponents)).toBe(true);
      expect(lastOps.length).toBeGreaterThanOrEqual(2);
    });

    it("streams data items incrementally for a repeated-template surface", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-stream-items";

      // List surface: Row root repeats one card template over /items.
      const fullArgs = JSON.stringify({
        surfaceId: "hotels",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: {
          items: [
            { name: "Alpha" },
            { name: "Bravo" },
            { name: "Charlie" },
          ],
        },
      });

      // Slice into many small deltas so item boundaries land on separate chunks.
      const deltas: BaseEvent[] = [];
      const chunk = 12;
      for (let i = 0; i < fullArgs.length; i += chunk) {
        deltas.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(i, i + chunk),
        } as BaseEvent);
      }

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "render_a2ui" },
        ...deltas,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));
      const snapshots = events.filter(isPaint);

      // Never emit a component without a `component` type (would throw in web_core).
      for (const snap of snapshots) {
        const ops = (snap as any).content.a2ui_operations as any[];
        for (const op of ops) {
          if (op.updateComponents) {
            for (const c of op.updateComponents.components) {
              expect(typeof c.component).toBe("string");
            }
          }
        }
      }

      // The data-model item count should grow across snapshots (progressive
      // hydration), reaching the full 3 items by the end.
      const itemCounts = snapshots
        .map((s) => {
          const ops = (s as any).content.a2ui_operations as any[];
          const dm = ops.find((op) => op.updateDataModel);
          return dm ? (dm.updateDataModel.value.items?.length ?? 0) : -1;
        })
        .filter((n) => n >= 0);

      expect(itemCounts.length).toBeGreaterThanOrEqual(2); // multiple data emits
      expect(Math.max(...itemCounts)).toBe(3); // ends fully hydrated
      // Monotonic non-decreasing growth.
      for (let i = 1; i < itemCounts.length; i++) {
        expect(itemCounts[i]).toBeGreaterThanOrEqual(itemCounts[i - 1]);
      }
      // TEETH: at least one PARTIAL data emit (fewer than the full 3 items)
      // must have been observed. This is the assertion that fails if streaming
      // is reverted to atomic data emission — atomic mode only ever emits the
      // full array, so every count would equal 3 and min would not be < 3.
      expect(Math.min(...itemCounts)).toBeLessThan(3);

      // updateComponents emitted exactly once-worth (atomic): the components
      // array is identical across every snapshot that carries it.
      const componentSets = snapshots
        .map((s) => {
          const ops = (s as any).content.a2ui_operations as any[];
          const uc = ops.find((op) => op.updateComponents);
          return uc ? JSON.stringify(uc.updateComponents.components) : null;
        })
        .filter((x): x is string => x !== null);
      expect(new Set(componentSets).size).toBe(1);
    });

    it("never emits an empty surface (createSurface always rides with components)", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId = "tc-early-surface";

      const fullArgs = JSON.stringify({
        surfaceId: "early",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "A" }] },
      });

      const deltas: BaseEvent[] = [];
      const chunk = 8;
      for (let i = 0; i < fullArgs.length; i += chunk) {
        deltas.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: fullArgs.substring(i, i + chunk),
        } as BaseEvent);
      }

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "render_a2ui" },
        ...deltas,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));
      const snapshots = events.filter(isPaint);

      // Every snapshot that carries createSurface must also carry components in
      // the same payload — an empty surface would make the renderer throw
      // "Component not found: root" before components arrive (a visible flash).
      for (const snap of snapshots) {
        const ops = (snap as any).content.a2ui_operations as any[];
        if (ops.some((op) => op.createSurface)) {
          expect(ops.some((op) => op.updateComponents)).toBe(true);
        }
      }
      // And the very first snapshot already includes components.
      const firstOps = (snapshots[0] as any).content.a2ui_operations as any[];
      expect(firstOps.some((op) => op.updateComponents)).toBe(true);
    });

    it("treats an empty-string defaultCatalogId as unset (no createSurface with catalogId='')", async () => {
      const middleware = new A2UIMiddleware({ defaultCatalogId: "" });
      const toolCallId = "tc-empty-catalog";

      const fullArgs = JSON.stringify({
        surfaceId: "s-empty",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "A" }] },
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: fullArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));
      const snapshots = events.filter(isPaint);
      // The createSurface op's catalogId must never be the empty string the
      // host accidentally configured — fall through to the basic catalog
      // (which the renderer can at least surface as a real, recognizable error).
      for (const snap of snapshots) {
        const ops = (snap as any).content.a2ui_operations as any[];
        for (const op of ops) {
          if (op.createSurface) {
            expect(op.createSurface.catalogId).not.toBe("");
            expect(typeof op.createSurface.catalogId).toBe("string");
            expect((op.createSurface.catalogId as string).length).toBeGreaterThan(0);
          }
        }
      }
    });

    it("falls back to the frontend-registered catalog id when no defaultCatalogId is configured", async () => {
      // Zero-config path: the host sets NO defaultCatalogId. The renderer ships
      // the catalog it registered as the A2UI schema context entry
      // ({ catalogId, components }). The middleware must stamp createSurface with
      // THAT id — not "basic" — so the surface resolves against the catalog the
      // frontend actually has.
      const middleware = new A2UIMiddleware({});
      const toolCallId = "tc-fe-catalog";

      const fullArgs = JSON.stringify({
        surfaceId: "s-fe",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "A" }] },
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: fullArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput({
        context: [
          {
            description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
            value: JSON.stringify({ catalogId: "declarative-gen-ui-catalog", components: {} }),
          },
        ],
      });

      const events = await collectEvents(middleware.run(input, mockAgent));
      const snapshots = events.filter(isPaint);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snap of snapshots) {
        const ops = (snap as any).content.a2ui_operations as any[];
        for (const op of ops) {
          if (op.createSurface) {
            expect(op.createSurface.catalogId).toBe("declarative-gen-ui-catalog");
          }
        }
      }
    });

    it("configured defaultCatalogId wins over the frontend-registered catalog id", async () => {
      // Explicit host override must take precedence over the frontend-shipped id.
      const middleware = new A2UIMiddleware({ defaultCatalogId: "server://override" });
      const toolCallId = "tc-config-wins";

      const fullArgs = JSON.stringify({
        surfaceId: "s-override",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "A" }] },
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: fullArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput({
        context: [
          {
            description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
            value: JSON.stringify({ catalogId: "declarative-gen-ui-catalog", components: {} }),
          },
        ],
      });

      const events = await collectEvents(middleware.run(input, mockAgent));
      const snapshots = events.filter(isPaint);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snap of snapshots) {
        const ops = (snap as any).content.a2ui_operations as any[];
        for (const op of ops) {
          if (op.createSurface) {
            expect(op.createSurface.catalogId).toBe("server://override");
          }
        }
      }
    });

    it("streaming intercept fires for a custom injectA2UITool name", async () => {
      // When the middleware injects the render tool under a non-default name,
      // the streaming intercept must recognize that name — otherwise the
      // progressive-render path silently downgrades to result-only.
      const middleware = new A2UIMiddleware({ injectA2UITool: "custom_render" });
      const toolCallId = "tc-custom-name";

      const fullArgs = JSON.stringify({
        surfaceId: "s-custom",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "X" }] },
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "custom_render" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: fullArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));
      const snapshots = events.filter(isPaint);
      // The custom-named tool's args must produce streaming ACTIVITY_SNAPSHOTs.
      expect(snapshots.length).toBeGreaterThan(0);
      const hasCreate = snapshots.some((s) =>
        (s as any).content.a2ui_operations.some((op: any) => op.createSurface?.surfaceId === "s-custom"),
      );
      expect(hasCreate).toBe(true);
    });

    it("streaming intercept fires with injectA2UITool:true even when a2uiToolNames is overridden", async () => {
      // Regression: a host that overrides `a2uiToolNames` (e.g. to add an extra
      // recognized name) while keeping `injectA2UITool: true` would previously
      // lose the default RENDER_A2UI_TOOL_NAME from the intercept set, because
      // the conditional only added a custom *string* name. The injected tool —
      // still named "render_a2ui" — would never open a streaming entry and
      // the progressive-render path would silently degrade to result-only.
      const middleware = new A2UIMiddleware({
        injectA2UITool: true,
        a2uiToolNames: ["some_other_extra_tool"],
      });
      const toolCallId = "tc-default-name-override";

      const fullArgs = JSON.stringify({
        surfaceId: "s-default",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "Y" }] },
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: fullArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));
      const snapshots = events.filter(isPaint);
      expect(snapshots.length).toBeGreaterThan(0);
      const hasCreate = snapshots.some((s) =>
        (s as any).content.a2ui_operations.some(
          (op: any) => op.createSurface?.surfaceId === "s-default",
        ),
      );
      expect(hasCreate).toBe(true);
    });

    it("does not suppress a second unrelated tool's a2ui_operations result after an earlier render streamed", async () => {
      // Earlier behaviour: any streaming entry with componentsEmitted=true
      // blanket-suppressed every subsequent a2ui_operations result in the
      // same run, even from an unrelated outer tool with a different
      // surface. Convergence fix: dedup is scoped to the outer call id.
      const middleware = new A2UIMiddleware();

      // 1. Inner render streams surface "s-first" inside outer call "outer-1".
      const innerCallId = "tc-inner";
      const outer1 = "outer-1";
      const innerArgs = JSON.stringify({
        surfaceId: "s-first",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "A" }] },
      });

      // 2. An unrelated outer tool "outer-2" returns a full a2ui_operations envelope
      //    for a different surface "s-second". The middleware must NOT swallow it.
      const outer2 = "outer-2";
      const secondEnvelope = JSON.stringify({
        a2ui_operations: [
          { version: "v0.9", createSurface: { surfaceId: "s-second", catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
          { version: "v0.9", updateComponents: { surfaceId: "s-second", components: [{ id: "root", component: "Text", text: "hi" }] } },
        ],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        // Outer call 1 opens.
        { type: EventType.TOOL_CALL_START, toolCallId: outer1, toolCallName: "generate_a2ui" },
        // Inner render_a2ui inside outer-1.
        { type: EventType.TOOL_CALL_START, toolCallId: innerCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: innerCallId, delta: innerArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: innerCallId },
        { type: EventType.TOOL_CALL_RESULT, toolCallId: outer1, content: JSON.stringify({ ok: true }) } as BaseEvent,
        // Outer call 2 opens — completely unrelated tool that legitimately
        // returns a different a2ui surface in its result content.
        { type: EventType.TOOL_CALL_START, toolCallId: outer2, toolCallName: "some_other_tool" },
        { type: EventType.TOOL_CALL_RESULT, toolCallId: outer2, content: secondEnvelope } as BaseEvent,
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));
      const snapshots = events.filter(isPaint);
      const surfaceIds = new Set<string>();
      for (const snap of snapshots) {
        const ops = (snap as any).content.a2ui_operations as any[];
        for (const op of ops) {
          if (op.createSurface) surfaceIds.add(op.createSurface.surfaceId);
          if (op.updateComponents) surfaceIds.add(op.updateComponents.surfaceId);
        }
      }
      expect(surfaceIds.has("s-first")).toBe(true);
      // Bucket (a) regression guard: dedup must not blanket-suppress
      // unrelated subsequent surfaces in the same run.
      expect(surfaceIds.has("s-second")).toBe(true);
    });

    it("paints a streamed surface exactly once when the final envelope re-wraps it under a different toolCallId (surfaceId dedup)", async () => {
      // Root cause: with the streaming path painting surface S (componentsEmitted
      // true, outerCallId null because generate_a2ui is itself an a2ui tool name
      // and never becomes the tracked outer call), the call-id linkage dedup
      // never matches the final envelope's toolCallId. The surfaceId guard must
      // still suppress the redundant final re-paint of S → exactly ONE anchor.
      const middleware = new A2UIMiddleware({ a2uiToolNames: ["render_a2ui", "generate_a2ui"] });

      const innerCallId = "tc-render-inner";
      const outerResultCallId = "tc-generate-outer"; // DIFFERENT id; no linkage to inner
      const innerArgs = JSON.stringify({
        surfaceId: "s-dup",
        components: [
          { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
          { id: "card", component: "HotelCard", name: { path: "name" } },
        ],
        data: { items: [{ name: "A" }] },
      });

      // Final envelope from generate_a2ui re-wraps the SAME surface s-dup.
      const finalEnvelope = JSON.stringify({
        a2ui_operations: [
          { version: "v0.9", createSurface: { surfaceId: "s-dup", catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
          { version: "v0.9", updateComponents: { surfaceId: "s-dup", components: [
            { id: "root", component: "Row", children: { componentId: "card", path: "/items" } },
            { id: "card", component: "HotelCard", name: { path: "name" } },
          ] } },
        ],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        // Inner render_a2ui streams surface s-dup (outerCallId stays null).
        { type: EventType.TOOL_CALL_START, toolCallId: innerCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: innerCallId, delta: innerArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: innerCallId },
        // generate_a2ui returns the final envelope for the SAME surface under a
        // DIFFERENT toolCallId — call-id linkage cannot match this.
        { type: EventType.TOOL_CALL_START, toolCallId: outerResultCallId, toolCallName: "generate_a2ui" },
        { type: EventType.TOOL_CALL_RESULT, toolCallId: outerResultCallId, content: finalEnvelope } as BaseEvent,
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));

      // Count distinct painted messageIds (DOM anchors) that carry a
      // createSurface/updateComponents for s-dup.
      const anchorIds = new Set<string>();
      for (const snap of events.filter(isPaint)) {
        const ops = (snap as any).content.a2ui_operations as any[];
        const touchesS = ops.some(
          (op) => op.createSurface?.surfaceId === "s-dup" || op.updateComponents?.surfaceId === "s-dup",
        );
        if (touchesS) anchorIds.add((snap as any).messageId);
      }
      // Exactly one anchor for s-dup: the streaming one. The final re-paint is suppressed.
      expect(anchorIds.size).toBe(1);
      expect([...anchorIds][0]).toBe(`a2ui-surface-${innerCallId}`);
    });

    it("still paints an UNRELATED surface from a later tool result after a streamed surface (no over-suppression by surfaceId)", async () => {
      // The surfaceId guard must only suppress surfaces THIS run already
      // streamed. A different surfaceId in a later tool result must still paint.
      const middleware = new A2UIMiddleware({ a2uiToolNames: ["render_a2ui", "generate_a2ui"] });

      const innerCallId = "tc-render-inner";
      const otherCallId = "tc-other";
      const innerArgs = JSON.stringify({
        surfaceId: "s-streamed",
        components: [{ id: "root", component: "Text", text: "hi" }],
        data: {},
      });
      const otherEnvelope = JSON.stringify({
        a2ui_operations: [
          { version: "v0.9", createSurface: { surfaceId: "s-other", catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json" } },
          { version: "v0.9", updateComponents: { surfaceId: "s-other", components: [{ id: "root", component: "Text", text: "other" }] } },
        ],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        { type: EventType.TOOL_CALL_START, toolCallId: innerCallId, toolCallName: "render_a2ui" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: innerCallId, delta: innerArgs } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: innerCallId },
        // Unrelated tool returns a DIFFERENT surface in its result envelope.
        { type: EventType.TOOL_CALL_START, toolCallId: otherCallId, toolCallName: "some_other_tool" },
        { type: EventType.TOOL_CALL_RESULT, toolCallId: otherCallId, content: otherEnvelope } as BaseEvent,
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const events = await collectEvents(middleware.run(createRunAgentInput(), mockAgent));
      const surfaceIds = new Set<string>();
      for (const snap of events.filter(isPaint)) {
        const ops = (snap as any).content.a2ui_operations as any[];
        for (const op of ops) {
          if (op.createSurface) surfaceIds.add(op.createSurface.surfaceId);
          if (op.updateComponents) surfaceIds.add(op.updateComponents.surfaceId);
        }
      }
      expect(surfaceIds.has("s-streamed")).toBe(true);
      // The unrelated surface in the later result must still paint.
      expect(surfaceIds.has("s-other")).toBe(true);
    });

    it("should produce distinct messageIds for different render_a2ui calls with the same surfaceId", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId1 = "tc-first";
      const toolCallId2 = "tc-second";

      const args1 = JSON.stringify({
        surfaceId: "shared-surface",
        catalogId: "basic",
        components: [{ id: "root", component: "Text", text: "First" }],
        items: [],
      });
      const args2 = JSON.stringify({
        surfaceId: "shared-surface",
        catalogId: "basic",
        components: [{ id: "root", component: "Text", text: "Second" }],
        items: [],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        // First tool call
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId1,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId1,
          delta: args1,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId1 },
        // Second tool call (same surfaceId, different toolCallId)
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId2,
          toolCallName: "render_a2ui",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId2,
          delta: args2,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId2 },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      // Should have two distinct ACTIVITY_SNAPSHOT events with different messageIds
      const snapshots = events.filter(isPaint);
      expect(snapshots).toHaveLength(2);

      const messageId1 = (snapshots[0] as any).messageId;
      const messageId2 = (snapshots[1] as any).messageId;
      expect(messageId1).not.toBe(messageId2);

      // OSS-162: the messageId is keyed by the (outer) call, not the surfaceId,
      // so the whole lifecycle for a call shares one id and the paint replaces the
      // skeleton in place. Distinct calls still get distinct ids via their toolCallId.
      expect(messageId1).toContain(toolCallId1);
      expect(messageId2).toContain(toolCallId2);
    });

    it("should produce distinct messageIds for auto-detected A2UI in different tool results", async () => {
      const middleware = new A2UIMiddleware();
      const toolCallId1 = "tc-auto-1";
      const toolCallId2 = "tc-auto-2";

      const a2uiResult = JSON.stringify({
        a2ui_operations: [
          { version: "v0.9", createSurface: { surfaceId: "shared-surface", catalogId: "basic" } },
          { version: "v0.9", updateComponents: { surfaceId: "shared-surface", components: [{ id: "root", component: "Text", text: "Hi" }] } },
        ],
      });

      const mockAgent = new MockAgent([
        { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
        // First tool call
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId1,
          toolCallName: "render_flights",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId1,
          delta: '{}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId1 },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "msg-1",
          toolCallId: toolCallId1,
          content: a2uiResult,
        },
        // Second tool call (same tool, same surfaceId, different toolCallId)
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallId2,
          toolCallName: "render_flights",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCallId2,
          delta: '{}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: toolCallId2 },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "msg-2",
          toolCallId: toolCallId2,
          content: a2uiResult,
        },
        { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
      ]);

      const input = createRunAgentInput();
      const events = await collectEvents(middleware.run(input, mockAgent));

      const snapshots = events.filter(isPaint);
      expect(snapshots).toHaveLength(2);

      const messageId1 = (snapshots[0] as any).messageId;
      const messageId2 = (snapshots[1] as any).messageId;
      expect(messageId1).not.toBe(messageId2);
      expect(messageId1).toContain(toolCallId1);
      expect(messageId2).toContain(toolCallId2);
    });
  });
});

describe("A2UI auto-detection in tool results", () => {
  // Silence console.warn from auto-detect best-effort paths (e.g. non-A2UI
  // strings that happen to look JSON-ish) so the test output stays clean.
  // Restored after each test so the spy doesn't leak into unrelated suites.
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("should emit ACTIVITY_SNAPSHOT when TOOL_CALL_RESULT contains a2ui_operations container", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-custom";

    const a2uiResult = JSON.stringify({
      a2ui_operations: [
        { surfaceUpdate: { surfaceId: "login-form", components: [{ id: "root", component: { Text: { text: { literalString: "Login" } } } }] } },
        { beginRendering: { surfaceId: "login-form", root: "root" } },
      ],
    });

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "show_login_form",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-1",
        toolCallId,
        content: a2uiResult,
      },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    // Should have the original TOOL_CALL_RESULT passed through
    const resultEvents = events.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(resultEvents).toHaveLength(1);

    // Should have auto-detected A2UI and emitted ACTIVITY_SNAPSHOT
    const activitySnapshots = events.filter(isPaint);
    expect(activitySnapshots.length).toBeGreaterThanOrEqual(1);
    expect((activitySnapshots[0] as any).activityType).toBe(A2UIActivityType);
    expect((activitySnapshots[0] as any).content.a2ui_operations).toHaveLength(2);
  });

  it("should NOT emit ACTIVITY_SNAPSHOT when TOOL_CALL_RESULT contains non-A2UI JSON", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-plain";

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "get_weather",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{"city": "NYC"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-2",
        toolCallId,
        content: JSON.stringify({ temperature: 72, condition: "sunny" }),
      },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    const activitySnapshots = events.filter(isPaint);
    expect(activitySnapshots).toHaveLength(0);

    const activityDeltas = events.filter((e) => e.type === EventType.ACTIVITY_DELTA);
    expect(activityDeltas).toHaveLength(0);
  });

  it("should NOT double-process render_a2ui — streaming handles it, auto-detect skips", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-render";

    const structuredArgs = JSON.stringify({
      surfaceId: "test-surface",
      catalogId: "basic",
      components: [{ id: "root", component: "Text", text: "Hello" }],
      items: [],
    });

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "render_a2ui",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: structuredArgs,
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    // Should have exactly one ACTIVITY_SNAPSHOT (from streaming, not auto-detection)
    const activitySnapshots = events.filter(isPaint);
    expect(activitySnapshots).toHaveLength(1);
  });

  it("should NOT emit ACTIVITY_SNAPSHOT for tool results without a2ui_operations container", async () => {
    const middleware = new A2UIMiddleware();
    const toolCallId = "tc-single";

    const mockAgent = new MockAgent([
      { type: EventType.RUN_STARTED, runId: "test", threadId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: "render_card",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: '{}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-3",
        toolCallId,
        content: JSON.stringify({ surfaceUpdate: { surfaceId: "card-1", components: [{ id: "root", component: { Card: { child: "text" } } }] } }),
      },
      { type: EventType.RUN_FINISHED, runId: "test", threadId: "test" },
    ]);

    const input = createRunAgentInput();
    const events = await collectEvents(middleware.run(input, mockAgent));

    const activitySnapshots = events.filter(isPaint);
    expect(activitySnapshots).toHaveLength(0);
  });
});

describe("tryParseA2UIOperations", () => {
  it("should extract operations from a2ui_operations container", () => {
    const input = JSON.stringify({
      a2ui_operations: [
        { surfaceUpdate: { surfaceId: "s1", components: [] } },
        { dataModelUpdate: { surfaceId: "s1", contents: [] } },
        { beginRendering: { surfaceId: "s1", root: "root" } },
      ],
    });
    const result = tryParseA2UIOperations(input);
    expect(result).not.toBeNull();
    expect(result!.operations).toHaveLength(3);
    expect(result!.operations[0]).toHaveProperty("surfaceUpdate");
    expect(result!.operations[1]).toHaveProperty("dataModelUpdate");
    expect(result!.operations[2]).toHaveProperty("beginRendering");
  });

  it("should return null for non-JSON text", () => {
    expect(tryParseA2UIOperations("not json")).toBeNull();
  });

  it("should return null for JSON without a2ui_operations key", () => {
    expect(tryParseA2UIOperations(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(tryParseA2UIOperations(JSON.stringify([{ foo: "bar" }]))).toBeNull();
    expect(tryParseA2UIOperations(JSON.stringify({ surfaceUpdate: { surfaceId: "s1", components: [] } }))).toBeNull();
  });

  it("should return null for primitive JSON values", () => {
    expect(tryParseA2UIOperations("42")).toBeNull();
    expect(tryParseA2UIOperations('"hello"')).toBeNull();
    expect(tryParseA2UIOperations("true")).toBeNull();
  });

  it("should return null for bare arrays (no container)", () => {
    const input = JSON.stringify([
      { beginRendering: { surfaceId: "s1", root: "root" } },
    ]);
    expect(tryParseA2UIOperations(input)).toBeNull();
  });
});

describe("extractSurfaceIds", () => {
  it("should extract unique surface IDs from v0.9 A2UI operations", () => {
    const messages: Array<Record<string, unknown>> = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      { version: "v0.9", updateComponents: { surfaceId: "s2", components: [] } },
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: {} } },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(2);
    expect(surfaceIds).toContain("s1");
    expect(surfaceIds).toContain("s2");
  });

  it("should handle messages without surfaceId", () => {
    const messages: Array<Record<string, unknown>> = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      { someOther: {} },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(1);
    expect(surfaceIds).toContain("s1");
  });

  it("should handle deleteSurface messages", () => {
    const messages: Array<Record<string, unknown>> = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
    ];

    const surfaceIds = extractSurfaceIds(messages);
    expect(surfaceIds).toHaveLength(1);
    expect(surfaceIds).toContain("s1");
  });
});

describe("A2UI_PROMPT", () => {
  it("should include markers and schema", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    expect(A2UI_PROMPT).toMatch(/^---BEGIN A2UI JSON SCHEMA---/);
    expect(A2UI_PROMPT).toMatch(/---END A2UI JSON SCHEMA---$/);
    expect(A2UI_PROMPT).toContain("createSurface");
    expect(A2UI_PROMPT).toContain("updateComponents");
  });

  it("should include rendering sequence instructions", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    // Check for the critical instruction about required message sequence
    expect(A2UI_PROMPT).toContain("Required Message Sequence");
    expect(A2UI_PROMPT).toContain("createSurface");
    // Check for the minimal working example
    expect(A2UI_PROMPT).toContain("Minimal Working Example");
  });

  it("should include v0.9 component format instructions", async () => {
    const { A2UI_PROMPT } = await import("../src/schema");
    // Check for v0.9 format instructions
    expect(A2UI_PROMPT).toContain("updateComponents");
    expect(A2UI_PROMPT).toContain("updateDataModel");
    expect(A2UI_PROMPT).toContain("v0.9");
  });
});
