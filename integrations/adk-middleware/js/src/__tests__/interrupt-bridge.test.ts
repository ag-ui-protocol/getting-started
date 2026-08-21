import type { RunAgentInput } from "@ag-ui/core";
import {
  AuthHandler,
  AuthCredentialTypes,
  InMemorySessionService,
  State,
  createEvent,
  type AuthConfig,
  type Session,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import {
  AG_UI_RESUME_COMPLETED_METADATA_KEY,
  AG_UI_RESUME_FINGERPRINT_METADATA_KEY,
  AG_UI_RESUME_REPLAY_METADATA_KEY,
} from "../constants";
import { prepareResume, toInterrupt } from "../interrupt-bridge";

function input(resume: NonNullable<RunAgentInput["resume"]>): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-2",
    state: {},
    messages: [{ id: "user-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    resume,
  };
}

async function pendingConfirmation(): Promise<Session> {
  const service = new InMemorySessionService();
  const session = await service.createSession({
    appName: "test-app",
    userId: "user-1",
    sessionId: "thread-1",
  });
  await service.appendEvent({
    session,
    event: createEvent({
      author: "approver",
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "confirm-1",
              name: "adk_request_confirmation",
              args: {
                originalFunctionCall: { name: "delete_record" },
                toolConfirmation: { hint: "Delete it?" },
              },
            },
          },
        ],
      },
      longRunningToolIds: ["confirm-1"],
    }),
  });
  return session;
}

async function pendingCredential(authConfig: AuthConfig): Promise<Session> {
  const service = new InMemorySessionService();
  const session = await service.createSession({
    appName: "test-app",
    userId: "user-1",
    sessionId: "thread-1",
  });
  await service.appendEvent({
    session,
    event: createEvent({
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
      longRunningToolIds: ["auth-1"],
    }),
  });
  return session;
}

describe("ADK interrupt bridge", () => {
  it("maps an AG-UI approval denial to ADK confirmed=false", async () => {
    const prepared = prepareResume(
      await pendingConfirmation(),
      input([
        {
          interruptId: "confirm-1",
          status: "resolved",
          payload: { approved: false },
        },
      ]),
    );

    expect(prepared?.kind).toBe("run");
    if (!prepared || prepared.kind !== "run") {
      throw new Error("Expected a prepared confirmation response.");
    }
    expect(
      prepared.content.parts?.[0].functionResponse?.response,
    ).toMatchObject({ confirmed: false });
  });

  it("rejects ambiguous resolved confirmation payloads instead of approving", async () => {
    const session = await pendingConfirmation();
    expect(() =>
      prepareResume(
        session,
        input([
          {
            interruptId: "confirm-1",
            status: "resolved",
            payload: { note: "maybe" },
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
  });

  it("rehydrates an API key into the AuthConfig consumed by ADK", async () => {
    const prepared = prepareResume(
      await pendingCredential({
        credentialKey: "calendar",
        authScheme: { type: "apiKey", name: "x-api-key", in: "header" },
        rawAuthCredential: { authType: AuthCredentialTypes.API_KEY },
      }),
      input([
        {
          interruptId: "auth-1",
          status: "resolved",
          payload: "API_KEY_FROM_BROWSER",
        },
      ]),
    );
    if (!prepared || prepared.kind !== "run") {
      throw new Error("Expected a prepared credential response.");
    }
    const response = prepared.content.parts?.[0].functionResponse?.response;
    expect(response).toMatchObject({
      credentialKey: "calendar",
      authScheme: { type: "apiKey" },
      exchangedAuthCredential: {
        authType: "apiKey",
        apiKey: "API_KEY_FROM_BROWSER",
      },
    });

    const state = new State();
    await new AuthHandler(
      response as unknown as AuthConfig,
    ).parseAndStoreAuthResponse(state);
    expect(state.get("temp:calendar")).toEqual({
      authType: "apiKey",
      apiKey: "API_KEY_FROM_BROWSER",
    });
  });

  it("merges OAuth callback data without allowing server material to be replaced", async () => {
    const prepared = prepareResume(
      await pendingCredential({
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
            clientId: "server-client",
            clientSecret: "SERVER_SECRET",
            codeVerifier: "SERVER_VERIFIER",
            state: "SERVER_STATE",
            redirectUri: "https://app.example/callback",
          },
        },
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: "server-client",
            clientSecret: "SERVER_SECRET",
            codeVerifier: "SERVER_VERIFIER",
            state: "SERVER_STATE",
            redirectUri: "https://app.example/callback",
            authUri: "https://auth.example/start",
          },
        },
      }),
      input([
        {
          interruptId: "auth-1",
          status: "resolved",
          payload: {
            exchangedAuthCredential: {
              authType: "oauth2",
              oauth2: {
                clientSecret: "CLIENT_OVERRIDE",
                codeVerifier: "CLIENT_OVERRIDE",
                state: "CLIENT_OVERRIDE",
                authResponseUri:
                  "https://app.example/callback?code=abc&state=SERVER_STATE",
              },
            },
          },
        },
      ]),
    );
    if (!prepared || prepared.kind !== "run") {
      throw new Error("Expected a prepared OAuth response.");
    }
    expect(
      prepared.content.parts?.[0].functionResponse?.response,
    ).toMatchObject({
      exchangedAuthCredential: {
        authType: "oauth2",
        oauth2: {
          clientSecret: "SERVER_SECRET",
          codeVerifier: "SERVER_VERIFIER",
          state: "SERVER_STATE",
          authResponseUri:
            "https://app.example/callback?code=abc&state=SERVER_STATE",
        },
      },
    });
  });

  it("rejects non-confirmation cancellation instead of treating it as input", async () => {
    const credentialSession = await pendingCredential({
      credentialKey: "calendar",
      authScheme: { type: "apiKey", name: "x-api-key", in: "header" },
      rawAuthCredential: { authType: AuthCredentialTypes.API_KEY },
    });
    expect(() =>
      prepareResume(
        credentialSession,
        input([{ interruptId: "auth-1", status: "cancelled" }]),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_INTERRUPT_CANCELLATION" }),
    );

    const confirmation = prepareResume(
      await pendingConfirmation(),
      input([{ interruptId: "confirm-1", status: "cancelled" }]),
    );
    expect(
      confirmation?.kind === "run"
        ? confirmation.content.parts?.[0].functionResponse?.response
        : undefined,
    ).toMatchObject({ confirmed: false });
  });

  it("uses protocol reasons, omits dangling tool ids, and redacts auth secrets", () => {
    const interrupt = toInterrupt({
      kind: "credential",
      interruptId: "auth-1",
      functionCallName: "adk_request_credential",
      author: "auth_agent",
      authConfig: {
        credentialKey: "calendar",
        authScheme: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://auth.example/authorize",
              tokenUrl: "https://auth.example/token",
              scopes: { calendar: "Calendar access" },
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: "public-client",
            clientSecret: "CLIENT_SECRET",
            refreshToken: "REFRESH_TOKEN",
            accessToken: "ACCESS_TOKEN",
            codeVerifier: "PKCE_SECRET",
            authUri: "https://auth.example/start",
          },
        },
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {
            scopes: ["calendar"],
            serviceAccountCredential: {
              type: "service_account",
              projectId: "project-id",
              privateKeyId: "private-key-id",
              privateKey: "PRIVATE_KEY",
              clientEmail: "service@example.test",
              clientId: "service-client-id",
              authUri: "https://accounts.example.test/auth",
              tokenUri: "https://accounts.example.test/token",
              authProviderX509CertUrl:
                "https://accounts.example.test/provider-cert",
              clientX509CertUrl: "https://accounts.example.test/client-cert",
              universeDomain: "example.test",
            },
          },
        },
      },
    });

    expect(interrupt).toMatchObject({
      id: "auth-1",
      reason: "google-adk:credential_required",
      metadata: {
        authConfig: {
          credentialKey: "calendar",
          rawAuthCredential: {
            authType: "oauth2",
            oauth2: {
              clientId: "public-client",
              authUri: "https://auth.example/start",
            },
          },
        },
      },
    });
    expect(interrupt).not.toHaveProperty("toolCallId");
    const serialized = JSON.stringify(interrupt);
    for (const secret of [
      "CLIENT_SECRET",
      "REFRESH_TOKEN",
      "ACCESS_TOKEN",
      "PKCE_SECRET",
      "PRIVATE_KEY",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(
      toInterrupt({
        kind: "input",
        interruptId: "input-1",
        functionCallName: "adk_request_input",
      }).reason,
    ).toBe("input_required");
    expect(
      toInterrupt({
        kind: "confirmation",
        interruptId: "confirm-1",
        functionCallName: "adk_request_confirmation",
      }),
    ).toMatchObject({ reason: "confirmation" });
  });

  it("treats response metadata as transport data for idempotent retries", async () => {
    const session = await pendingConfirmation();
    const first = prepareResume(
      session,
      input([
        {
          interruptId: "confirm-1",
          status: "resolved",
          payload: { approved: true },
          metadata: { attempt: 1 },
        },
      ]),
    );
    if (!first || first.kind !== "run") {
      throw new Error("Expected a prepared resume.");
    }
    session.events.push(
      createEvent({
        author: "user",
        customMetadata: {
          [AG_UI_RESUME_FINGERPRINT_METADATA_KEY]: first.resumeFingerprint,
          [AG_UI_RESUME_COMPLETED_METADATA_KEY]: true,
          [AG_UI_RESUME_REPLAY_METADATA_KEY]: {
            state: { done: true },
            interrupts: [],
          },
        },
      }),
    );

    const retried = prepareResume(
      session,
      input([
        {
          interruptId: "confirm-1",
          status: "resolved",
          payload: { approved: true },
          metadata: { attempt: 2, traceId: "different" },
        },
      ]),
    );
    expect(retried).toEqual({
      kind: "replay",
      artifact: {
        state: { done: true },
        interrupts: [],
      },
    });
  });
});
