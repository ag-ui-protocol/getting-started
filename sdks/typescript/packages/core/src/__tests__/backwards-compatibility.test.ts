import { EventType } from "../events";
import {
  UserMessageSchema,
  AssistantMessageSchema,
  RunAgentInputSchema,
  TextMessageStartEventSchema,
  RunStartedEventSchema,
  ToolSchema,
  ContextSchema,
} from "../schemas";

describe("Backwards Compatibility", () => {
  describe("Message Schemas", () => {
    it("should accept UserMessage with extra fields from future versions", () => {
      const messageWithExtraFields = {
        id: "msg_1",
        role: "user" as const,
        content: "Hello",
        futureField: "This is from a future version",
        anotherNewProp: { nested: "data" },
      };

      const result = UserMessageSchema.safeParse(messageWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("msg_1");
        expect(result.data.role).toBe("user");
        expect(result.data.content).toBe("Hello");
        // Extra fields should be stripped (Zod default behavior)
        expect('futureField' in result.data).toBe(false);
        expect('anotherNewProp' in result.data).toBe(false);
      }
    });

    it("should accept AssistantMessage with extra fields", () => {
      const messageWithExtraFields = {
        id: "msg_2",
        role: "assistant" as const,
        content: "Response",
        newFeatureFlag: true,
        experimentalData: [1, 2, 3],
      };

      const result = AssistantMessageSchema.safeParse(messageWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("msg_2");
        expect(result.data.content).toBe("Response");
      }
    });
  });

  describe("RunAgentInput Schema", () => {
    it("should accept RunAgentInput with extra fields at top level", () => {
      const inputWithExtraFields = {
        threadId: "thread_1",
        runId: "run_1",
        parentRunId: "parent_run_1",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
        // Extra fields from future version
        newFeatureFlag: true,
        experimentalTimeout: 5000,
        futureConfig: { option: "value" },
      };

      const result = RunAgentInputSchema.safeParse(inputWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.threadId).toBe("thread_1");
        expect(result.data.runId).toBe("run_1");
        expect(result.data.parentRunId).toBe("parent_run_1");
      }
    });

    it("should accept RunAgentInput with messages containing extra fields", () => {
      const inputWithExtraFieldsInMessages = {
        threadId: "thread_2",
        runId: "run_2",
        state: {},
        messages: [
          {
            id: "m1",
            role: "user" as const,
            content: "Hi",
            extraProp: "value",
            metadata: { source: "web" },
          },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
      };

      const result = RunAgentInputSchema.safeParse(inputWithExtraFieldsInMessages);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages.length).toBe(1);
        expect(result.data.messages[0].content).toBe("Hi");
      }
    });
  });

  describe("Event Schemas", () => {
    it("should accept TextMessageStartEvent with extra fields", () => {
      const eventWithExtraFields = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg_1",
        role: "assistant" as const,
        // Extra fields from future version
        metadata: { tokenCount: 10 },
        experimentalFeature: true,
      };

      const result = TextMessageStartEventSchema.safeParse(eventWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe(EventType.TEXT_MESSAGE_START);
        expect(result.data.messageId).toBe("msg_1");
      }
    });

    it("should accept RunStartedEvent with extra fields", () => {
      const eventWithExtraFields = {
        type: EventType.RUN_STARTED,
        threadId: "thread_1",
        runId: "run_1",
        // Extra fields from future version
        startTime: Date.now(),
        priority: "high",
      };

      const result = RunStartedEventSchema.safeParse(eventWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.threadId).toBe("thread_1");
        expect(result.data.runId).toBe("run_1");
      }
    });
  });

  describe("Tool and Context Schemas", () => {
    it("should accept Tool with extra fields", () => {
      const toolWithExtraFields = {
        name: "calculator",
        description: "Performs calculations",
        parameters: { type: "object" },
        // Extra fields from future version
        version: "2.0",
        deprecationWarning: null,
      };

      const result = ToolSchema.safeParse(toolWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("calculator");
        expect(result.data.description).toBe("Performs calculations");
      }
    });

    it("should accept Context with extra fields", () => {
      const contextWithExtraFields = {
        description: "User preferences",
        value: '{"theme":"dark"}',
        // Extra fields from future version
        priority: 1,
        expiresAt: Date.now() + 3600000,
      };

      const result = ContextSchema.safeParse(contextWithExtraFields);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.description).toBe("User preferences");
        expect(result.data.value).toBe('{"theme":"dark"}');
      }
    });
  });

  describe("Complex nested structures", () => {
    it("should handle deeply nested objects with extra fields at multiple levels", () => {
      const complexInput = {
        threadId: "thread_complex",
        runId: "run_complex",
        state: { currentStep: 1 },
        messages: [
          {
            id: "m1",
            role: "user" as const,
            content: "Hello",
            extraUserProp: "value1",
          },
          {
            id: "m2",
            role: "assistant" as const,
            content: "Hi there",
            toolCalls: [
              {
                id: "tc1",
                type: "function" as const,
                function: {
                  name: "search",
                  arguments: "{}",
                  extraFunctionProp: "value2",
                },
                extraToolCallProp: "value3",
              },
            ],
            extraAssistantProp: "value4",
          },
        ],
        tools: [
          {
            name: "search",
            description: "Search tool",
            parameters: {},
            extraToolProp: "value5",
          },
        ],
        context: [
          {
            description: "ctx",
            value: "val",
            extraContextProp: "value6",
          },
        ],
        forwardedProps: { custom: true },
        extraTopLevelProp: "value7",
      };

      const result = RunAgentInputSchema.safeParse(complexInput);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messages.length).toBe(2);
        expect((result.data.messages[1] as any).toolCalls?.length).toBe(1);
        expect(result.data.tools.length).toBe(1);
        expect(result.data.context.length).toBe(1);
      }
    });
  });
});
