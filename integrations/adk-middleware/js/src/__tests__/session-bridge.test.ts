import type { RunAgentInput } from "@ag-ui/core";
import {
  Agent,
  createEvent,
  InMemorySessionService,
  Runner,
  type Session,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { indexAgentTree } from "../agent-tree";
import { ADK_METADATA_KEY, AG_UI_MESSAGE_ID_METADATA_KEY } from "../constants";
import { prepareRunInput } from "../session-bridge";
import { runInput } from "./helpers";

async function setupSession() {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    appName: "test-app",
    sessionService,
    agent: new Agent({
      name: "streaming_agent",
      model: "gemini-2.5-flash",
    }),
  });
  const session = await sessionService.createSession({
    appName: runner.appName,
    userId: "user-1",
    sessionId: "thread-1",
  });
  await sessionService.appendEvent({
    session,
    event: createEvent({
      id: "persisted-a",
      invocationId: "parallel-invocation",
      author: "streaming_agent",
      branch: "root.a",
      content: { role: "model", parts: [{ text: "Persisted branch" }] },
    }),
  });
  return { runner, session };
}

function input(messages: RunAgentInput["messages"]): RunAgentInput {
  return runInput({ runId: "run-2", messages });
}

function prepare(runner: Runner, session: Session, input: RunAgentInput) {
  return prepareRunInput(
    runner,
    session,
    input,
    new AbortController().signal,
    indexAgentTree(runner.agent),
  );
}

describe("prepareRunInput ADK output reconciliation", () => {
  it("does not suppress an unpersisted parallel branch with the same invocation id", async () => {
    const { runner, session } = await setupSession();

    await prepare(
      runner,
      session,
      input([
        {
          id: "streamed-b",
          role: "assistant",
          name: "streaming_agent",
          content: "Unpersisted branch",
          metadata: {
            [ADK_METADATA_KEY]: {
              eventId: "stream-b",
              invocationId: "parallel-invocation",
              author: "streaming_agent",
              branch: "root.b",
            },
          },
        },
        { id: "user-2", role: "user", content: "Continue" },
      ]),
    );

    expect(
      session.events.some(
        (event) =>
          event.customMetadata?.[AG_UI_MESSAGE_ID_METADATA_KEY] ===
          "streamed-b",
      ),
    ).toBe(true);
  });

  it("never treats client-owned user input as persisted ADK output", async () => {
    const { runner, session } = await setupSession();

    const prepared = await prepare(
      runner,
      session,
      input([
        {
          id: "user-2",
          role: "user",
          content: "Continue",
          metadata: {
            [ADK_METADATA_KEY]: {
              eventId: "persisted-a",
              invocationId: "parallel-invocation",
              author: "streaming_agent",
              branch: "root.a",
            },
          },
        },
      ]),
    );

    expect(prepared).toMatchObject({
      kind: "run",
      content: { role: "user", parts: [{ text: "Continue" }] },
    });
  });

  it("skips an activity message in preload instead of appending it to ADK history", async () => {
    const { runner, session } = await setupSession();
    const before = session.events.length;

    const prepared = await prepare(
      runner,
      session,
      input([
        {
          id: "activity-1",
          role: "activity",
          activityType: "ui.navigation",
          content: { route: "/x" },
        },
        { id: "user-2", role: "user", content: "Continue" },
      ]),
    );

    expect(prepared.kind).toBe("run");
    expect(session.events.length).toBe(before);
    expect(
      session.events.some(
        (event) =>
          event.customMetadata?.[AG_UI_MESSAGE_ID_METADATA_KEY] ===
          "activity-1",
      ),
    ).toBe(false);
  });

  it("does not start a run on an activity message as the newest input", async () => {
    const { runner, session } = await setupSession();
    await expect(
      prepare(
        runner,
        session,
        input([
          {
            id: "activity-1",
            role: "activity",
            activityType: "ui.navigation",
            content: { route: "/x" },
          },
        ]),
      ),
    ).rejects.toThrow(/requires a new user\/tool message/);
  });

  it("does not append the resumed answer twice when a resume is retried", async () => {
    const { runner, session } = await setupSession();
    await runner.sessionService.appendEvent({
      session,
      event: createEvent({
        author: "streaming_agent",
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "ask-1",
                name: "adk_request_input",
                args: { message: "?" },
              },
            },
          ],
        },
        longRunningToolIds: ["ask-1"],
      }),
    });
    const resume = {
      ...input([]),
      resume: [
        {
          interruptId: "ask-1",
          status: "resolved" as const,
          payload: "the blue one",
        },
      ],
    };
    // The runner never ran between these two calls (a crash after the first
    // append), so the pending request is unchanged and the retry must reuse
    // the reply turn that is already in the session.
    await prepare(runner, session, resume);
    await prepare(runner, session, resume);
    const replies = session.events.filter((event) =>
      event.invocationId?.startsWith("ag-ui-resume-reply-"),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content?.parts?.[0]?.text).toBe("the blue one");
  });

  it("refuses a run with no new input instead of re-running stale history", async () => {
    const { runner, session } = await setupSession();
    await expect(prepare(runner, session, input([]))).rejects.toThrow(
      /requires a new user\/tool message/,
    );
  });
});
