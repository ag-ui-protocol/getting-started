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

import { AG_UI_RUN_KEY } from "../constants";
import { prepareResume, toInterrupt } from "../interrupt-bridge";
import { runInput } from "./helpers";

function input(resume: NonNullable<RunAgentInput["resume"]>): RunAgentInput {
  return runInput({ runId: "run-2", resume });
}

async function pendingInput(responseSchema: unknown): Promise<Session> {
  const service = new InMemorySessionService();
  const session = await service.createSession({
    appName: "test-app",
    userId: "user-1",
    sessionId: "thread-1",
  });
  await service.appendEvent({
    session,
    event: createEvent({
      author: "asker",
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "ask-1",
              name: "adk_request_input",
              args: { message: "Which?", response_schema: responseSchema },
            },
          },
        ],
      },
      longRunningToolIds: ["ask-1"],
    }),
  });
  return session;
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
                toolConfirmation: { hint: "Delete it?", payload: { id: 7 } },
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
  it("reports an unusable ADK response schema instead of validating against nothing", async () => {
    const session = await pendingInput({ $ref: "#/definitions/missing" });
    let thrown: unknown;
    try {
      prepareResume(
        session,
        input([{ interruptId: "ask-1", status: "resolved", payload: "x" }]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVALID_RESPONSE_SCHEMA" });
  });

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

  it("keeps ADK's original confirmation hint and payload over browser values", async () => {
    const prepared = prepareResume(
      await pendingConfirmation(),
      input([
        {
          interruptId: "confirm-1",
          status: "resolved",
          payload: {
            approved: true,
            hint: "attacker hint",
            payload: { id: 999 },
          },
        },
      ]),
    );

    if (!prepared || prepared.kind !== "run") {
      throw new Error("Expected a prepared confirmation response.");
    }
    expect(prepared.content.parts?.[0].functionResponse?.response).toEqual({
      confirmed: true,
      hint: "Delete it?",
      payload: { id: 7 },
    });
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
          [AG_UI_RUN_KEY]: {
            runId: "run-2",
            emittedMessageIds: [],
            resume: {
              fingerprint: first.resumeFingerprint,
              replay: {
                state: { done: true },
                messages: [{ id: "user-1", role: "user", content: "Hello" }],
                interrupts: [],
              },
            },
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
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        interrupts: [],
      },
    });
  });

  it("rejects a contradictory approved/confirmed pair instead of approving", async () => {
    // {approved:false, confirmed:true} used to fall through to whichever
    // field was read first, silently approving a denied action.
    const session = await pendingConfirmation();
    expect(() =>
      prepareResume(
        session,
        input([
          {
            interruptId: "confirm-1",
            status: "resolved",
            payload: { approved: false, confirmed: true },
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
  });

  it("rejects a non-boolean confirmed or approved field instead of coercing it", async () => {
    // HTML forms send "false" for an unchecked box; a truthy string must never
    // approve a tool call.
    const session = await pendingConfirmation();
    for (const payload of [
      { confirmed: "yes" },
      { approved: 1 },
      { confirmed: "false" },
    ]) {
      expect(() =>
        prepareResume(
          session,
          input([{ interruptId: "confirm-1", status: "resolved", payload }]),
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    }
  });

  it("resolves a bare confirmed=true into an ADK approval", async () => {
    const prepared = prepareResume(
      await pendingConfirmation(),
      input([
        {
          interruptId: "confirm-1",
          status: "resolved",
          payload: { confirmed: true },
        },
      ]),
    );
    if (!prepared || prepared.kind !== "run") {
      throw new Error("Expected a prepared confirmation response.");
    }
    expect(
      prepared.content.parts?.[0].functionResponse?.response,
    ).toMatchObject({
      confirmed: true,
      hint: "Delete it?",
      payload: { id: 7 },
    });
  });

  it("rejects two resume entries for the same interrupt instead of answering it twice", async () => {
    const session = await pendingConfirmation();
    expect(() =>
      prepareResume(
        session,
        input([
          { interruptId: "confirm-1", status: "resolved", payload: true },
          { interruptId: "confirm-1", status: "resolved", payload: false },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_INTERRUPT_ID" }));
  });

  it("rejects a resume for an interrupt that was never raised", async () => {
    // Otherwise a client could inject a fabricated function response into the
    // ADK session for a call the agent never made.
    const session = await pendingConfirmation();
    expect(() =>
      prepareResume(
        session,
        input([
          { interruptId: "confirm-1", status: "resolved", payload: true },
          { interruptId: "never-raised", status: "resolved", payload: true },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_INTERRUPT_ID" }));
  });

  it("produces the same resume fingerprint regardless of entry order", async () => {
    // The idempotency replay is keyed on the fingerprint; if two interrupts
    // resumed in a different order hashed differently, a retried resume would
    // silently re-run the model and tools instead of replaying.
    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    await service.appendEvent({
      session,
      event: createEvent({
        author: "asker",
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "ask-a",
                name: "adk_request_input",
                args: { message: "A?" },
              },
            },
            {
              functionCall: {
                id: "ask-b",
                name: "adk_request_input",
                args: { message: "B?" },
              },
            },
          ],
        },
        longRunningToolIds: ["ask-a", "ask-b"],
      }),
    });
    const a = { interruptId: "ask-a", status: "resolved" as const, payload: 1 };
    const b = { interruptId: "ask-b", status: "resolved" as const, payload: 2 };
    const forward = prepareResume(session, input([a, b]));
    const reversed = prepareResume(session, input([b, a]));
    if (forward?.kind !== "run" || reversed?.kind !== "run") {
      throw new Error("Expected prepared resumes.");
    }
    expect(reversed.resumeFingerprint).toBe(forward.resumeFingerprint);
  });

  it("rejects a corrupt replay artifact instead of replaying an empty conversation", async () => {
    const session = await pendingConfirmation();
    const first = prepareResume(
      session,
      input([{ interruptId: "confirm-1", status: "resolved", payload: true }]),
    );
    if (first?.kind !== "run") {
      throw new Error("Expected a prepared resume.");
    }
    session.events.push(
      createEvent({
        author: "user",
        customMetadata: {
          [AG_UI_RUN_KEY]: {
            runId: "run-2",
            emittedMessageIds: [],
            // `messages` is missing: replaying this would wipe the client's
            // conversation on an idempotent retry.
            resume: {
              fingerprint: first.resumeFingerprint,
              replay: { state: {}, interrupts: [] },
            },
          },
        },
      }),
    );
    expect(() =>
      prepareResume(
        session,
        input([
          { interruptId: "confirm-1", status: "resolved", payload: true },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REPLAY_ARTIFACT" }),
    );
  });

  const oauthAuthConfig = (): AuthConfig => ({
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
      oauth2: { clientId: "server-client", clientSecret: "SERVER_SECRET" },
    },
    exchangedAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: "server-client",
        clientSecret: "SERVER_SECRET",
        state: "SERVER_STATE",
        authUri: "https://auth.example/start",
      },
    },
  });

  it("turns a bare OAuth callback URI string into oauth2.authResponseUri", async () => {
    const prepared = prepareResume(
      await pendingCredential(oauthAuthConfig()),
      input([
        {
          interruptId: "auth-1",
          status: "resolved",
          payload: "https://app.example/callback?code=abc&state=SERVER_STATE",
        },
      ]),
    );
    if (prepared?.kind !== "run") {
      throw new Error("Expected a prepared OAuth response.");
    }
    expect(
      prepared.content.parts?.[0].functionResponse?.response,
    ).toMatchObject({
      exchangedAuthCredential: {
        authType: "oauth2",
        oauth2: {
          clientSecret: "SERVER_SECRET",
          authResponseUri:
            "https://app.example/callback?code=abc&state=SERVER_STATE",
        },
      },
    });
  });

  it("rejects an OAuth reply that answers with neither authResponseUri nor authCode", async () => {
    // ADK 2.x drops such a reply with a log line and never resumes the tool;
    // a ready-made access token from the browser must fail loudly instead.
    const session = await pendingCredential(oauthAuthConfig());
    for (const payload of [
      {
        exchangedAuthCredential: {
          authType: "oauth2",
          oauth2: { accessToken: "STOLEN" },
        },
      },
      { oauth2: { accessToken: "STOLEN" } },
      { authType: "oauth2", oauth2: {} },
    ]) {
      expect(() =>
        prepareResume(
          session,
          input([{ interruptId: "auth-1", status: "resolved", payload }]),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_CREDENTIAL_PAYLOAD" }),
      );
    }
  });

  it("keeps server-owned OAuth material for every accepted payload shape", async () => {
    for (const payload of [
      {
        rawAuthCredential: {
          oauth2: { clientSecret: "X", authCode: "code-1" },
        },
      },
      { oauth2: { clientSecret: "X", state: "X", authCode: "code-1" } },
      { authType: "oauth2", oauth2: { clientSecret: "X", authCode: "code-1" } },
      { clientSecret: "X", authCode: "code-1" }, // wrapped as oauth2 for OAuth templates
    ]) {
      const prepared = prepareResume(
        await pendingCredential(oauthAuthConfig()),
        input([{ interruptId: "auth-1", status: "resolved", payload }]),
      );
      if (prepared?.kind !== "run") {
        throw new Error("Expected a prepared OAuth response.");
      }
      expect(
        prepared.content.parts?.[0].functionResponse?.response,
      ).toMatchObject({
        exchangedAuthCredential: {
          oauth2: {
            clientId: "server-client",
            clientSecret: "SERVER_SECRET",
            state: "SERVER_STATE",
            authCode: "code-1",
          },
        },
      });
    }
  });

  it("keeps the server's HTTP auth scheme over a client-supplied one", async () => {
    const prepared = prepareResume(
      await pendingCredential({
        credentialKey: "api",
        authScheme: { type: "http", scheme: "bearer" },
        rawAuthCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: { scheme: "bearer", credentials: {} },
        },
      }),
      input([
        {
          interruptId: "auth-1",
          status: "resolved",
          payload: { http: { scheme: "basic", credentials: { token: "t" } } },
        },
      ]),
    );
    if (prepared?.kind !== "run") {
      throw new Error("Expected a prepared HTTP response.");
    }
    expect(
      prepared.content.parts?.[0].functionResponse?.response,
    ).toMatchObject({
      exchangedAuthCredential: {
        authType: "http",
        http: { scheme: "bearer", credentials: { token: "t" } },
      },
    });
  });

  it("rejects an empty API key instead of handing ADK an empty credential", async () => {
    const authConfig: AuthConfig = {
      credentialKey: "calendar",
      authScheme: { type: "apiKey", name: "x-api-key", in: "header" },
      rawAuthCredential: { authType: AuthCredentialTypes.API_KEY },
    };
    const session = await pendingCredential(authConfig);
    for (const payload of ["", { apiKey: "" }, { authType: "apiKey" }]) {
      expect(() =>
        prepareResume(
          session,
          input([{ interruptId: "auth-1", status: "resolved", payload }]),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_CREDENTIAL_PAYLOAD" }),
      );
    }
  });

  it("rejects a credential request whose server-side AuthConfig is unusable", async () => {
    const cases: Array<[AuthConfig | undefined, string]> = [
      [undefined, "no AuthConfig"],
      [{ credentialKey: "k" } as AuthConfig, "no auth scheme"],
      [
        {
          credentialKey: "k",
          authScheme: { type: "apiKey", name: "x", in: "header" },
        } as AuthConfig,
        "no credential template",
      ],
    ];
    for (const [authConfig, why] of cases) {
      const session = await pendingCredential(authConfig as AuthConfig);
      expect(
        () =>
          prepareResume(
            session,
            input([
              { interruptId: "auth-1", status: "resolved", payload: "key" },
            ]),
          ),
        why,
      ).toThrowError(expect.objectContaining({ code: "INVALID_AUTH_CONFIG" }));
    }
  });

  it("echoes only free-form input answers as model-visible text, never confirmations or credentials", async () => {
    const confirmed = prepareResume(
      await pendingConfirmation(),
      input([{ interruptId: "confirm-1", status: "resolved", payload: true }]),
    );
    expect(confirmed).not.toHaveProperty("inputReplyText");

    const credential = prepareResume(
      await pendingCredential({
        credentialKey: "calendar",
        authScheme: { type: "apiKey", name: "x-api-key", in: "header" },
        rawAuthCredential: { authType: AuthCredentialTypes.API_KEY },
      }),
      input([{ interruptId: "auth-1", status: "resolved", payload: "SECRET" }]),
    );
    expect(credential).not.toHaveProperty("inputReplyText");

    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    await service.appendEvent({
      session,
      event: createEvent({
        author: "asker",
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "ask-1",
                name: "adk_request_input",
                args: { message: "Which?" },
              },
            },
          ],
        },
        longRunningToolIds: ["ask-1"],
      }),
    });
    const asText = prepareResume(
      session,
      input([
        { interruptId: "ask-1", status: "resolved", payload: "the blue one" },
      ]),
    );
    expect(asText).toMatchObject({ inputReplyText: "the blue one" });
    const asJson = prepareResume(
      session,
      input([
        { interruptId: "ask-1", status: "resolved", payload: { b: 2, a: 1 } },
      ]),
    );
    expect(asJson).toMatchObject({ inputReplyText: '{"a":1,"b":2}' });
    const noPayload = prepareResume(
      session,
      input([{ interruptId: "ask-1", status: "resolved" }]),
    );
    expect(noPayload).not.toHaveProperty("inputReplyText");
  });
});
