import {
  EventType,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  RawEvent,
  CustomEvent,
} from "@ag-ui/core";
import { describe, it, expect } from "vitest";
import { encode, decode } from "../src/proto";
import { expectRoundTripEquality } from "./test-utils";

describe("Run Events and Misc Events", () => {
  describe("Run Events", () => {
    it("should round-trip encode/decode RunStartedEvent event", () => {
      const event: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        timestamp: Date.now(),
        threadId: "thread-1234",
        runId: "run-5678",
      };

      expectRoundTripEquality(event);
    });

    it("should round-trip encode/decode RunFinishedEvent event (legacy, no outcome)", () => {
      // Confirms back-compat: pre-interrupt-aware producers omit `outcome`
      // entirely and the round-trip preserves that.
      const event: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        timestamp: Date.now(),
        threadId: "thread-1234",
        runId: "run-5678",
      };

      expectRoundTripEquality(event);
    });

    it("should round-trip encode/decode RunErrorEvent event", () => {
      const event: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        timestamp: Date.now(),
        message: "Failed to execute tool call",
      };

      expectRoundTripEquality(event);
    });

    it("should handle RunErrorEvent with detailed error info", () => {
      const event: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: "API request failed",
        code: "API_ERROR",
      };

      expectRoundTripEquality(event);
    });
  });

  describe("Step Events", () => {
    it("should round-trip encode/decode StepStartedEvent event", () => {
      const event: StepStartedEvent = {
        type: EventType.STEP_STARTED,
        timestamp: Date.now(),
        stepName: "data_analysis",
      };

      expectRoundTripEquality(event);
    });

    it("should round-trip encode/decode StepFinishedEvent event", () => {
      const event: StepFinishedEvent = {
        type: EventType.STEP_FINISHED,
        timestamp: Date.now(),
        stepName: "data_analysis",
      };

      expectRoundTripEquality(event);
    });

    it("should handle StepStartedEvent with minimal fields", () => {
      const event: StepStartedEvent = {
        type: EventType.STEP_STARTED,
        stepName: "process_payment",
      };

      expectRoundTripEquality(event);
    });

    it("should handle StepFinishedEvent with minimal fields", () => {
      const event: StepFinishedEvent = {
        type: EventType.STEP_FINISHED,
        stepName: "process_payment",
      };

      expectRoundTripEquality(event);
    });
  });

  describe("RawEvent", () => {
    it("should round-trip encode/decode RawEvent", () => {
      const event: RawEvent = {
        type: EventType.RAW,
        timestamp: Date.now(),
        event: {
          type: "user_action",
          action: "button_click",
          elementId: "submit-btn",
          timestamp: Date.now(),
        },
        source: "frontend",
      };

      expectRoundTripEquality(event);
    });

    it("should handle complex nested data in RawEvent", () => {
      const event: RawEvent = {
        type: EventType.RAW,
        event: {
          type: "analytics_event",
          session: {
            id: "sess-12345",
            user: {
              id: "user-456",
              attributes: {
                plan: "premium",
                signupDate: "2023-01-15",
                preferences: ["feature1", "feature2"],
              },
            },
            actions: [
              { type: "page_view", path: "/home", timestamp: 1676480210000 },
              {
                type: "button_click",
                elementId: "cta-1",
                timestamp: 1676480215000,
              },
              {
                type: "form_submit",
                formId: "signup",
                timestamp: 1676480230000,
                data: { email: "user@example.com" },
              },
            ],
          },
          metadata: {
            source: "web",
            version: "1.2.3",
            environment: "production",
          },
        },
      };

      expectRoundTripEquality(event);
    });
  });

  describe("CustomEvent", () => {
    it("should round-trip encode/decode CustomEvent", () => {
      const event: CustomEvent = {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "user_preference_updated",
        value: {
          theme: "dark",
          fontSize: "medium",
          notifications: true,
        },
      };

      expectRoundTripEquality(event);
    });

    it("carries a CustomEvent without a value through decode unrepaired", () => {
      // The schema requires value (an explicit null is the way to say
      // "nothing"), and this event is malformed. Decoding no longer judges it:
      // it reports the absence faithfully and the client's enforcement stage
      // rejects it, exactly as it rejects the same JSON off an SSE stream.
      // Inventing a value here would be the corruption the schema forbids, and
      // throwing here would make the binary path harsher than the text one.
      const event = {
        type: EventType.CUSTOM,
        name: "heartbeat",
      } as unknown as CustomEvent;

      const decoded = decode(encode(event)) as unknown as Record<string, unknown>;

      expect(decoded.type).toBe(EventType.CUSTOM);
      expect(decoded.name).toBe("heartbeat");
      expect("value" in decoded).toBe(false);
    });

    it("round-trips a CustomEvent with an explicit null value", () => {
      const event: CustomEvent = {
        type: EventType.CUSTOM,
        name: "heartbeat",
        value: null,
      };

      expectRoundTripEquality(event);
    });

    it("should handle complex values in CustomEvent", () => {
      const event: CustomEvent = {
        type: EventType.CUSTOM,
        name: "analytics_update",
        value: {
          metrics: {
            active_users: 12345,
            conversion_rate: 0.0354,
            revenue: 98765.43,
          },
          segments: [
            { name: "new_users", count: 543, growth: 0.12 },
            { name: "returning_users", count: 876, growth: -0.05 },
            { name: "power_users", count: 234, growth: 0.08 },
          ],
          period: {
            start: "2023-01-01",
            end: "2023-01-31",
            duration_days: 31,
          },
          trends: {
            daily: [10, 12, 15, 14, 18, 20, 22],
            weekly: [70, 85, 92, 105],
            monthly: [320, 370],
          },
        },
      };

      expectRoundTripEquality(event);
    });
  });

  describe("Edge Cases", () => {
    it("should handle basic fields for each event type", () => {
      const events = [
        {
          type: EventType.RUN_STARTED,
          threadId: "thread-basic",
          runId: "run-basic",
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: "thread-basic",
          runId: "run-basic",
        },
        { type: EventType.CUSTOM, name: "empty", value: null },
      ];

      for (const event of events) {
        const encoded = encode(event);
        const decoded = decode(encoded);
        expect(decoded.type).toBe(event.type);
      }
    });

    it("should handle events with all base fields", () => {
      const runEvents = [
        {
          type: EventType.RUN_STARTED,
          timestamp: Date.now(),
          threadId: "thread-full",
          runId: "run-full",
          rawEvent: { original: "data", from: "external_system" },
        },
        {
          type: EventType.RUN_FINISHED,
          timestamp: Date.now(),
          threadId: "thread-full",
          runId: "run-full",
          rawEvent: { original: "data", from: "external_system" },
        },
      ];

      const nonRunEvents = [
        {
          type: EventType.RUN_ERROR,
          message: "Test error",
          timestamp: Date.now(),
          rawEvent: { original: "data", from: "external_system" },
        },
        {
          type: EventType.CUSTOM,
          name: "full_event",
          value: { payload: true },
          timestamp: Date.now(),
          rawEvent: { original: "data", from: "external_system" },
        },
      ];

      for (const event of [...runEvents, ...nonRunEvents]) {
        expectRoundTripEquality(event);
      }
    });
  });
});
