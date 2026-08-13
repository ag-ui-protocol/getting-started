import { EventType } from "../events";
import { ActivitySnapshotEventSchema, ActivityDeltaEventSchema, ActivityMessageSchema } from "../schemas";

describe("Activity events", () => {
  it("parses ActivitySnapshotEvent", () => {
    const result = ActivitySnapshotEventSchema.parse({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "msg_activity",
      activityType: "PLAN",
      content: { tasks: ["search"] },
    });

    expect(result.type).toBe(EventType.ACTIVITY_SNAPSHOT);
    expect(result.messageId).toBe("msg_activity");
    expect(result.content.tasks).toEqual(["search"]);
    expect(result.replace).toBe(true);
  });

  it("respects replace flag in ActivitySnapshotEvent", () => {
    const result = ActivitySnapshotEventSchema.parse({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "msg_activity",
      activityType: "PLAN",
      content: { tasks: [] },
      replace: false,
    });

    expect(result.replace).toBe(false);
  });

  it("parses ActivityDeltaEvent", () => {
    const result = ActivityDeltaEventSchema.parse({
      type: EventType.ACTIVITY_DELTA,
      messageId: "msg_activity",
      activityType: "PLAN",
      patch: [{ op: "replace", path: "/tasks/0", value: "✓ search" }],
    });

    expect(result.type).toBe(EventType.ACTIVITY_DELTA);
    expect(result.patch).toHaveLength(1);
  });

  it("parses ActivityMessage", () => {
    const result = ActivityMessageSchema.parse({
      id: "activity_1",
      role: "activity" as const,
      activityType: "PLAN",
      content: { tasks: [] },
    });

    expect(result.activityType).toBe("PLAN");
    expect(result.content).toEqual({ tasks: [] });
  });
});
