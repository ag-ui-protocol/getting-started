import { EventType, type Message, type RunAgentInput } from "@ag-ui/core";
import {
  AuthCredentialTypes,
  InMemorySessionService,
  createEvent,
  type AuthConfig,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { AG_UI_STATE_KEYS_KEY } from "../constants";
import { ADKEventTranslator } from "../event-translator";
import { convertMessage } from "../message-converter";
import { MessageSnapshot } from "../message-snapshot";
import { stateDeltaFromInput } from "../state-bridge";

function input(state: unknown): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-2",
    state,
    messages: [{ id: "user-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

describe("ADK state and identity bridges", () => {
  it("tombstones keys removed from the authoritative AG-UI snapshot", async () => {
    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
      state: {
        keep: 1,
        removed: "stale",
        [AG_UI_STATE_KEYS_KEY]: ["keep", "removed"],
      },
    });

    expect(stateDeltaFromInput(input({ keep: 2 }), session)).toMatchObject({
      keep: 2,
      removed: null,
      [AG_UI_STATE_KEYS_KEY]: ["keep"],
    });
  });

  it("does not adopt backend state when an existing session has no manifest", async () => {
    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
      state: { backendOwned: "keep" },
    });

    expect(stateDeltaFromInput(input({ uiOwned: "new" }), session)).toEqual(
      expect.objectContaining({
        uiOwned: "new",
        [AG_UI_STATE_KEYS_KEY]: ["uiOwned"],
      }),
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        stateDeltaFromInput(input({ uiOwned: "new" }), session),
        "backendOwned",
      ),
    ).toBe(false);
  });

  it("preserves ADK authors in streamed and restored assistant messages", () => {
    const translator = new ADKEventTranslator({});
    const events = translator.translate(
      createEvent({
        id: "specialist-message",
        author: "specialist",
        content: { role: "model", parts: [{ text: "Specialist answer" }] },
      }),
    );
    expect(
      events.find((event) => event.type === EventType.TEXT_MESSAGE_START),
    ).toMatchObject({ name: "specialist" });

    const message: Message = {
      id: "specialist-message",
      role: "assistant",
      name: "specialist",
      content: "Specialist answer",
    };
    expect(
      convertMessage(
        message,
        [message],
        "root_agent",
        new Set(["root_agent", "specialist"]),
      ),
    ).toMatchObject({ author: "specialist" });
  });

  it("preserves tool-only agent identity and function-call thought signatures", () => {
    const event = createEvent({
      id: "specialist-tool-message",
      author: "specialist",
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "lookup-1",
              name: "lookup",
              args: { query: "Vienna" },
            },
            thoughtSignature: "opaque-tool-signature",
          },
        ],
      },
    });
    const events = new ADKEventTranslator({}).translate(event);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "specialist-tool-message",
          name: "specialist",
        }),
        expect.objectContaining({
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "tool-call",
          entityId: "lookup-1",
          encryptedValue: "opaque-tool-signature",
        }),
      ]),
    );

    const snapshot = new MessageSnapshot([]);
    for (const translated of events) {
      snapshot.apply(translated);
    }
    expect(snapshot.getMessages()).toEqual([
      expect.objectContaining({
        id: "specialist-tool-message",
        role: "assistant",
        name: "specialist",
        toolCalls: [
          expect.objectContaining({
            id: "lookup-1",
            encryptedValue: "opaque-tool-signature",
          }),
        ],
      }),
    ]);
  });

  it("redacts AuthConfig secrets from raw ADK event projections", () => {
    const authConfig = {
      credentialKey: "calendar",
      authScheme: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://auth.example/authorize",
            tokenUrl: "https://auth.example/token",
            scopes: {},
          },
        },
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: "public-client",
          clientSecret: "SERVER_SECRET",
          codeVerifier: "PKCE_SECRET",
        },
      },
    } satisfies AuthConfig;
    const event = createEvent({
      id: "auth-request",
      author: "auth-agent",
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "auth-1",
              name: "adk_request_credential",
              args: { authConfig },
            },
          },
        ],
      },
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: { "tool-call": authConfig },
        requestedToolConfirmations: {},
      },
    });

    const translator = new ADKEventTranslator({}, true);
    const translated = [
      ...translator.translate(event),
      ...translator.translate(
        createEvent({
          id: "auth-response",
          author: "user",
          content: {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "auth-1",
                  name: "adk_request_credential",
                  response: {
                    ...authConfig,
                    exchangedAuthCredential: {
                      authType: AuthCredentialTypes.OAUTH2,
                      oauth2: {
                        clientId: "public-client",
                        clientSecret: "REHYDRATED_SERVER_SECRET",
                        authResponseUri:
                          "https://app.example/callback?code=abc",
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
      ),
    ];
    const serialized = JSON.stringify(translated);
    expect(serialized).toContain("public-client");
    expect(serialized).not.toContain("SERVER_SECRET");
    expect(serialized).not.toContain("PKCE_SECRET");
    expect(serialized).not.toContain("REHYDRATED_SERVER_SECRET");
    expect(JSON.stringify(event)).toContain("SERVER_SECRET");
  });

  it("removes internal ADK state from mapped and fallback raw events", () => {
    const event = createEvent({
      id: "state-event",
      author: "root_agent",
      actions: {
        stateDelta: {
          visible: "browser-safe",
          "app:secret": "APP_SECRET",
          "user:secret": "USER_SECRET",
          "temp:credential": "TEMP_SECRET",
          _ag_ui_context: "INTERNAL_CONTEXT",
        },
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    });
    const translated = new ADKEventTranslator({}).translate(event);
    const stateEvent = translated.find(
      (candidate) => candidate.type === EventType.STATE_DELTA,
    );

    expect(stateEvent).toMatchObject({
      type: EventType.STATE_DELTA,
      rawEvent: { actions: { stateDelta: { visible: "browser-safe" } } },
    });
    expect(JSON.stringify(translated)).not.toMatch(
      /APP_SECRET|USER_SECRET|TEMP_SECRET|INTERNAL_CONTEXT/,
    );
    expect(JSON.stringify(event)).toContain("TEMP_SECRET");

    const privateOnly = createEvent({
      id: "private-state-event",
      author: "root_agent",
      actions: {
        stateDelta: { "temp:token": "RAW_SECRET" },
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    });
    const rawFallback = new ADKEventTranslator({}).translate(privateOnly);
    expect(rawFallback).toHaveLength(1);
    expect(rawFallback[0]).toMatchObject({
      type: EventType.RAW,
      event: { actions: { stateDelta: {} } },
    });
    expect(JSON.stringify(rawFallback)).not.toContain("RAW_SECRET");
  });

  it("rejects restored history attributed to an unknown ADK agent", () => {
    const message: Message = {
      id: "unknown-message",
      role: "assistant",
      name: "not_in_tree",
      content: "Hello",
    };
    expect(() =>
      convertMessage(message, [message], "root_agent", new Set(["root_agent"])),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_AGENT_AUTHOR" }));
  });

  it("counts final ADK SSE usage once instead of adding the partial duplicate", () => {
    const translator = new ADKEventTranslator({});
    const usageMetadata = {
      promptTokenCount: 3,
      candidatesTokenCount: 2,
      totalTokenCount: 5,
    };
    translator.translate(
      createEvent({
        id: "partial",
        author: "root_agent",
        partial: true,
        usageMetadata,
        content: { role: "model", parts: [{ text: "Hi" }] },
      }),
    );
    translator.translate(
      createEvent({
        id: "final",
        author: "root_agent",
        usageMetadata,
        content: { role: "model", parts: [{ text: "Hi" }] },
      }),
    );

    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      },
    ]);
  });

  it("deduplicates repeated non-progressive aggregates but counts the next tool turn", () => {
    const translator = new ADKEventTranslator({});
    const usageMetadata = {
      promptTokenCount: 3,
      candidatesTokenCount: 2,
      totalTokenCount: 5,
    };
    for (const id of ["aggregate-part", "aggregate-final"]) {
      translator.translate(
        createEvent({
          id,
          invocationId: "invocation-1",
          author: "root_agent",
          usageMetadata,
        }),
      );
    }
    translator.translate(
      createEvent({
        id: "tool-result",
        invocationId: "invocation-1",
        author: "root_agent",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "tool-1",
                name: "lookup",
                response: { result: "done" },
              },
            },
          ],
        },
      }),
    );
    translator.translate(
      createEvent({
        id: "next-turn",
        invocationId: "invocation-1",
        author: "root_agent",
        usageMetadata,
      }),
    );

    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10,
      },
    ]);
  });

  it("groups usage by provider and model without inventing missing counts", () => {
    const translator = new ADKEventTranslator({}, false, (event) =>
      event.author === "local_agent" ? "openai-compatible" : "google",
    );
    const google = createEvent({
      id: "google-usage",
      author: "google_agent",
      usageMetadata: { promptTokenCount: 2 },
    });
    google.modelVersion = "gemini-test";
    const local = createEvent({
      id: "local-usage",
      author: "local_agent",
      usageMetadata: { candidatesTokenCount: 3 },
    });
    local.modelVersion = "gemma-test";

    translator.translate(google);
    translator.translate(local);

    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        model: "gemini-test",
        inputTokens: 2,
      },
      {
        provider: "openai-compatible",
        model: "gemma-test",
        outputTokens: 3,
      },
    ]);
  });
});
