package com.agui.adk.integration;

import com.google.adk.agents.RunConfig;
import com.google.adk.events.EventActions;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.agui.adk.AdkRunnerClient;
import com.agui.adk.GoogleAdkAgent;
import com.agui.adk.SessionManager;
import com.agui.adk.SessionManagerTestFixtures;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.encoding.PreEncodedEvent;
import com.agui.adk.hitl.ConfirmationRequestStore;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingToolCall;
import com.agui.adk.hitl.SessionConfirmationRequestStore;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.ReasoningEndEvent;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.ReasoningMessageEndEvent;
import com.agui.community.core.event.ReasoningMessageStartEvent;
import com.agui.community.core.event.ReasoningStartEvent;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.StateDeltaEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * End-to-end parity tests for the Google ADK (Java) to AG-UI 4j bridge.
 *
 * <p>Every scenario drives the public {@link GoogleAdkAgent#run(RunAgentInput)} entry point through a
 * draining fake {@link AdkRunnerClient} and asserts the exact external AG-UI event stream. These tests
 * are strict TDD against existing production code: they compile and pass against the bridge as written
 * and record genuine parity behaviour, including known gaps, rather than modifying production.
 */
class BridgeEndToEndTest {

    private static final String PROCESSED_MESSAGE_IDS_KEY = "processedMessageIds";
    private static final String FINGERPRINTS_STATE_KEY = "_ag_ui_message_fingerprints";

    // ---- Scenario 1: first turn ---- //
    @Test
    void scenario1FirstTurnRunsOneUnseenMessageAndResolvesSession() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        String messageId = "first-message";
        RunAgentInput input = agentInput(List.of(new UserMessage(messageId, "Hello")), List.of(), Map.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread-1", "run-1"),
                new RunFinishedEvent("thread-1", "run-1", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(runner.runCount()).isOne();
        assertThat(runner.lastUserId).isEqualTo("test-user");
        assertThat(runner.lastSessionId).isEqualTo("thread-1");
        verify(sessions).markMessagesProcessedWithFingerprints(any(), anyList());
    }

    // ---- Scenario 2: second turn ---- //
    @Test
    void scenario2SecondTurnSkipsProcessedMessageAndRunsOnlyNewUnseenMessage() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        String firstId = "first-message";
        String secondId = "second-message";
        RunAgentInput firstTurn = agentInput(List.of(new UserMessage(firstId, "Hello")), List.of(), Map.of());
        // Mutable processed set: first turn sees firstId unseen, second turn sees it already processed.
        Set<String> processed = new java.util.HashSet<>();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenAnswer(invocation -> {
                    AdkAgUiRunContext context = invocation.getArgument(0);
                    return Single.just(resolvedSession(context.input(), processed));
                });
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        collect(subscribe(agent.run(firstTurn)));
        assertThat(runner.runCount()).isOne();
        processed.add(firstId);

        // Second turn: firstId already processed in session state, secondId is unseen.
        RunAgentInput secondTurn = agentInput(List.of(
                new UserMessage(firstId, "Hello"), new UserMessage(secondId, "Second")), List.of(), Map.of());
        RecordingSubscriber subscriber = subscribe(agent.run(secondTurn));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread-1", "run-1"),
                new RunFinishedEvent("thread-1", "run-1", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(runner.runCount()).isEqualTo(2);
    }

    @Test
    void requestWithNoUnseenMessagesStillEmitsSessionSnapshotWithoutRunningAdk() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        RunAgentInput input = agentInput(List.of(new UserMessage("processed", "Hello")), List.of(), Map.of());
        ResolvedSession resolved = resolvedSession(input, Set.of("processed"));
        resolved.session().state().put("persisted", "value");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolved));
        when(sessions.getSessionState(any())).thenAnswer(invocation -> {
            Session session = invocation.getArgument(0);
            return Map.copyOf(session.state());
        });
        when(sessions.getAuthoritativeSessionState("test-app", "test-user", "thread-1"))
                .thenAnswer(ignored -> Maybe.just(Map.copyOf(resolved.session().state())));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread-1", "run-1"),
                new StateSnapshotEvent(Map.of(
                        "processedMessageIds", Set.of("processed"),
                        "_ag_ui_message_fingerprints", Map.of(
                                "processed", com.agui.adk.message.MessageFingerprint.of(
                                        new UserMessage("processed", "Hello"))),
                        "persisted", "value")),
                new RunFinishedEvent("thread-1", "run-1", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(runner.runCount()).isZero();
    }

    @Test
    void secondTurnSnapshotIncludesPersistedFirstTurnStateAndStripsTempKeys() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        RunAgentInput firstTurn = agentInput(List.of(new UserMessage("first", "Hello")), List.of(), Map.of());
        ResolvedSession resolved = resolvedSession(firstTurn, Set.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolved));
        when(sessions.getSessionState(any())).thenAnswer(invocation -> {
            Session session = invocation.getArgument(0);
            return Map.copyOf(session.state());
        });
        when(sessions.getAuthoritativeSessionState("test-app", "test-user", "thread-1"))
                .thenAnswer(ignored -> Maybe.just(Map.copyOf(resolved.session().state())));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        collect(subscribe(agent.run(firstTurn)));
        resolved.session().state().put("fromFirstTurn", "persisted");
        resolved.session().state().put("temp:requestOnly", "hidden");

        RunAgentInput secondTurn = agentInput(List.of(new UserMessage("second", "Again")), List.of(), Map.of());
        RecordingSubscriber subscriber = subscribe(agent.run(secondTurn));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).filteredOn(StateSnapshotEvent.class::isInstance).singleElement()
                .isInstanceOfSatisfying(StateSnapshotEvent.class, snapshot -> {
                    assertThat(snapshot.snapshot()).isInstanceOf(Map.class);
                    @SuppressWarnings("unchecked")
                    Map<Object, Object> state = (Map<Object, Object>) snapshot.snapshot();
                    assertThat(state).containsEntry("fromFirstTurn", "persisted");
                    assertThat(state).doesNotContainKey("temp:requestOnly");
                });
    }

    // ---- Scenario 3: Nth turn ---- //
    @Test
    void scenario3NthTurnProcessesOnlyTheNewestUnseenOfThreeMessages() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        String msg1 = "message-1";
        String msg2 = "message-2";
        String msg3 = "message-3";
        RunAgentInput input = agentInput(List.of(
                new UserMessage(msg1, "one"),
                new UserMessage(msg2, "two"),
                new UserMessage(msg3, "three")), List.of(), Map.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of(msg1, msg2))));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        AtomicBoolean onlyNewest = new AtomicBoolean(true);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenAnswer(invocation -> {
            List<Message> processed = invocation.getArgument(1);
            onlyNewest.set(processed.stream().map(Message::id).toList().equals(List.of(msg3)));
            return Completable.complete();
        });

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).containsExactly(
                new RunStartedEvent("thread-1", "run-1"),
                new RunFinishedEvent("thread-1", "run-1", new com.agui.community.core.interrupt.SuccessOutcome(), null, null, null));
        assertThat(runner.runCount()).isOne();
        assertThat(onlyNewest).isTrue();
    }

    // ---- Scenario 4: server (backend) tool then user message ---- //
    @Test
    void scenario4ServerToolCallAndResultThenUserTextEmitFullAgUiToolSequence() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        RunAgentInput input = agentInput(List.of(new UserMessage("m1", "Hi")), List.of(), Map.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        runner.events.add(backendCall("provider-1", "weather"));
        runner.events.add(backendResponse("provider-1", "weather"));
        runner.events.add(textEvent("It will be sunny"));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).extracting(this::toolLabel).containsSubsequence(
                "start:provider-1", "end:provider-1", "result:provider-1");
        assertThat(subscriber.events).anyMatch(event -> event.toString().contains("It will be sunny"));
    }

    // ---- Scenario 5: frontend tool ---- //
    @Test
    void scenario5FrontendToolIsExposedToAdkRunConfigAsVisibleTool() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        Tool tool = new Tool("pick", "Select an item", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = agentInput(List.of(new UserMessage("m1", "Hi")), List.of(tool),
                Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("rawToolSchemas", List.of(Map.of(
                        "position", 0, "name", "pick", "schema", Map.of("type", "object"))))));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(runner.visibleToolNames()).containsExactly("pick");
        assertThat(runner.runCount()).isOne();
    }

    @Test
    void prefixedFrontendCallIsPersistedThroughPublicAgentRun() throws Exception {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        runner.beforeEvents = runConfig -> {
            AdkAgUiRunContext runContext = AdkAgUiRunContext.from(runConfig).orElseThrow();
            com.google.adk.agents.ReadonlyContext readonly = mock(com.google.adk.agents.ReadonlyContext.class);
            com.google.adk.agents.InvocationContext invocation = mock(com.google.adk.agents.InvocationContext.class);
            when(readonly.invocationContext()).thenReturn(invocation);
            when(invocation.runConfig()).thenReturn(runConfig);
            new com.agui.adk.tool.AgUiToolset(List.of("pick"), "frontend")
                    .getTools(readonly).toList().blockingGet();
        };
        GoogleAdkAgent agent = agent(
                sessions, runner, store, new SessionConfirmationRequestStore(), chunkEncoder());
        Tool tool = new Tool("pick", "Select", new ToolParameters(Map.of(), List.of()));
        RunAgentInput input = agentInput(List.of(new UserMessage("m1", "Hi")), List.of(tool),
                Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY, Map.of("rawToolSchemas", List.of(Map.of(
                        "position", 0, "name", "pick", "schema", Map.of("type", "object"))))));
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        runner.events.add(backendCall("frontend-call", "frontend_pick"));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        PendingCallScope scope = new PendingCallScope("test-app", "test-user", "thread-1");
        assertThat(store.pending(scope).map(call -> call.event().toolCallName()).toList().blockingGet())
                .containsExactly("frontend_pick");
    }

    // ---- Scenario 6: HITL approval/resume ---- //
    @Test
    void scenario6HitlApprovalRequiresNativeRequestThenResumeCompletesTheTool() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        SessionConfirmationRequestStore confirmations = new SessionConfirmationRequestStore();
        GoogleAdkAgent agent = agent(sessions, runner, new SessionPendingCallStore(), confirmations,
                chunkEncoder());
        ResolvedSession session = resolvedSession("thread");
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(session));
        when(sessions.findExistingSession("test-app", "test-user", "thread")).thenReturn(Maybe.just(session));
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        // First run surfaces the native confirmation request to the client (captures it, pauses).
        runner.events.add(nativeConfirmationEvent("invocation", "call"));
        RecordingSubscriber pauseSubscriber = subscribe(agent.run(new RunAgentInput("thread", "run", null,
                List.of(new UserMessage("prompt", "continue")), List.of(), List.of(), null)));
        List<Event> paused = collect(pauseSubscriber);
        assertThat(paused).as("paused events").isNotEmpty();
        com.agui.community.core.interrupt.Interrupt interrupt = paused.stream()
                .filter(RunFinishedEvent.class::isInstance)
                .map(RunFinishedEvent.class::cast)
                .map(RunFinishedEvent::outcome)
                .filter(com.agui.community.core.interrupt.InterruptOutcome.class::isInstance)
                .map(com.agui.community.core.interrupt.InterruptOutcome.class::cast)
                .flatMap(outcome -> outcome.interrupts().stream())
                .findFirst().orElseThrow(() -> new AssertionError("missing interrupt in " + paused));

        // The user resumes with the bridge-owned opaque interrupt identifier.
        collect(subscribe(agent.run(new RunAgentInput("thread", "run-resume", null,
                List.of(), List.of(), List.of(), null, List.of(new com.agui.community.core.interrupt.Resume(
                        interrupt.id(), com.agui.community.core.interrupt.ResumeStatus.RESOLVED,
                        Map.of("approved", true)))))));

        assertThat(runner.contents).hasSize(2);
        assertNativeConfirmation(runner.contents.get(1), "invocation", "call", true);
    }

    // ---- Scenario 7: multi-tool + mixed tools ---- //
    @Test
    void scenario7MixedFrontendAndBackendCallsOrderDeterministically() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner, store,
                new SessionConfirmationRequestStore(), chunkEncoder());
        // Pre-loaded full stream: partial mixed frontend+backend calls, the backend result, and the
        // richer frontend final. The bridge retains/deferres the backend lifecycle until the richer
        // frontend final is seen, then emits everything in one deterministic order.
        runner.events.add(partialMixedFrontendAndBackendCalls());
        runner.events.add(backendResponse("backend-b", "weather"));
        runner.events.add(finalFrontendCallWithRicherArgs());
        RunAgentInput input = mixedInput();
        when(sessions.resolveSession(any(AdkAgUiRunContext.class))).thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());

        RecordingSubscriber run = subscribe(agent.run(input));

        assertThat(run.await()).isTrue();
        assertThat(run.error).isNull();
        assertThat(run.events).extracting(this::toolLabel).containsSubsequence(
                "chunk:frontend-a",
                "start:backend-b", "end:backend-b", "result:backend-b");
        assertThat(run.events).filteredOn(ToolCallChunkEvent.class::isInstance).hasSize(1);
        assertThat(run.events).filteredOn(ToolCallResultEvent.class::isInstance).hasSize(1);
    }

    // ---- Scenario 8: pending replay ---- //
    @Test
    void scenario8PendingFrontendCallReplaysExactRetainedJsonOnResubmission() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        SessionPendingCallStore store = new SessionPendingCallStore();
        PendingCallScope scope = new PendingCallScope("app", "user", "resolved-session");
        ToolCallChunkEvent event = new ToolCallChunkEvent("pending-call", "pick",
                "{\"choice\":\"rich\"}");
        String json = "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"pending-call\","
                + "\"toolCallName\":\"pick\",\"delta\":\"{\\\"choice\\\":\\\"rich\\\"}\"}";
        store.persist(new PendingToolCall(
                new PendingCallKey(new PendingCallGroupKey(scope, "invocation"), event.toolCallId()),
                event, json, PendingStatus.PENDING)).blockingAwait();
        ResolvedSession session = new ResolvedSession(Session.builder("resolved-session")
                .appName("app").userId("user").build(), new SessionMapping(
                new SessionMappingKey("app", "user", "thread"), "resolved-session"));
        when(sessions.findExistingSession("app", "user", "thread")).thenReturn(Maybe.just(session));

        GoogleAdkAgent agent = GoogleAdkAgent.builder()
                .runner(mock(AdkRunnerClient.class))
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> "unused")
                .pendingCallStore(store)
                .eventEncoder(ignored -> new EncodedEvent(ignored, "must-not-be-used"))
                .build();

        RecordingSubscriber replay = subscribe(agent.replayPendingCalls("app", "user", "thread", Set.of()));

        assertThat(replay.await()).isTrue();
        assertThat(replay.error).isNull();
        assertThat(replay.events).singleElement().isInstanceOfSatisfying(ToolCallChunkEvent.class, chunk -> {
            assertThat(chunk.toolCallId()).isEqualTo("pending-call");
            assertThat(chunk.rawEvent()).isEqualTo(new PreEncodedEvent(event, json));
        });
    }

    // ---- Scenario 9: reasoning ---- //
    @Test
    void scenario9ThoughtPartialsMapToExactReasoningEventSequence() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        RunAgentInput input = agentInput(List.of(new UserMessage("m1", "Hi")), List.of(), Map.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        runner.events.add(partialThoughtEvent("thought-7"));
        runner.events.add(finalThoughtEvent("thought-7"));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events)
                .filteredOn(event -> event instanceof ReasoningStartEvent
                        || event instanceof ReasoningMessageStartEvent
                        || event instanceof ReasoningMessageContentEvent
                        || event instanceof ReasoningMessageEndEvent
                        || event instanceof ReasoningEndEvent)
                .containsExactly(
                        new ReasoningStartEvent("thought-7"),
                        new ReasoningMessageStartEvent("thought-7"),
                        new ReasoningMessageContentEvent("thought-7", "plan steps"),
                        new ReasoningMessageContentEvent("thought-7", " done"),
                        new ReasoningMessageEndEvent("thought-7"),
                        new ReasoningEndEvent("thought-7"));
    }

    // ---- Scenario 10: state ---- //
    @Test
    void directPostRunSessionMutationIncludesAgUiKeysAndStripsTempKeys() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        RunAgentInput input = agentInput(List.of(new UserMessage("m1", "Hi")), List.of(), Map.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        java.util.concurrent.atomic.AtomicReference<Map<String, Object>> authoritative =
                new java.util.concurrent.atomic.AtomicReference<>(Map.of());
        runner.beforeEvents = ignored -> authoritative.set(Map.of(
                "directMutation", "persisted",
                "temp:scratch", "hidden",
                "_ag_ui_internal", "hidden-too"));
        when(sessions.getAuthoritativeSessionState("test-app", "test-user", "thread-1"))
                .thenAnswer(ignored -> Maybe.just(authoritative.get()));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).filteredOn(StateSnapshotEvent.class::isInstance).singleElement()
                .isEqualTo(new StateSnapshotEvent(Map.of(
                        "directMutation", "persisted", "_ag_ui_internal", "hidden-too")));
    }

    @Test
    void scenario10AdkStateDeltaIsProjectedIntoAgUiStateEvents() throws InterruptedException {
        SessionManager sessions = mock(SessionManager.class);
        FakeAdkRunnerClient runner = new FakeAdkRunnerClient();
        GoogleAdkAgent agent = agent(sessions, runner);
        RunAgentInput input = agentInput(List.of(new UserMessage("m1", "Hi")), List.of(), Map.of());
        when(sessions.resolveSession(any(AdkAgUiRunContext.class)))
                .thenReturn(Single.just(resolvedSession(input, Set.of())));
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.markMessagesProcessedWithFingerprints(any(), anyList())).thenReturn(Completable.complete());
        runner.events.add(stateDeltaEvent(Map.of("count", 1, "_ag_ui_hidden", true)));
        Session finalSession = resolvedSession(input, Set.of()).session();
        finalSession.state().put("count", 1);
        finalSession.state().put("_ag_ui_hidden", true);
        when(sessions.getAuthoritativeSessionState("test-app", "test-user", "thread-1"))
                .thenReturn(Maybe.just(Map.copyOf(finalSession.state())));

        RecordingSubscriber subscriber = subscribe(agent.run(input));

        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        assertThat(subscriber.events).filteredOn(StateDeltaEvent.class::isInstance).singleElement();
        assertThat(subscriber.events).filteredOn(StateSnapshotEvent.class::isInstance).singleElement()
                .isInstanceOfSatisfying(StateSnapshotEvent.class, snapshot ->
                        assertThat(snapshot.snapshot()).isEqualTo(Map.of(
                                "count", 1, "_ag_ui_hidden", true,
                                "processedMessageIds", Set.of(),
                                "_ag_ui_message_fingerprints", Map.of())));
        // Known parity gap: the bridge only projects ADK stateDelta into the AG-UI event stream via
        // StateDeltaEvent/StateSnapshotEvent in the translator layer. It does NOT merge those deltas
        // back into the persisted session state (only processedMessageIds/fingerprints are persisted).
        assertThat(runner.lastStateDelta).isEmpty();
    }

    // ---- builder helpers ---- //
    private GoogleAdkAgent agent(SessionManager sessions, FakeAdkRunnerClient runner) {
        return agent(sessions, runner, new SessionPendingCallStore(), new SessionConfirmationRequestStore(),
                chunkEncoder());
    }

    private GoogleAdkAgent agent(
            SessionManager sessions,
            FakeAdkRunnerClient runner,
            com.agui.adk.hitl.PendingCallStore store,
            ConfirmationRequestStore confirmations,
            CanonicalEventEncoder encoder) {
        SessionManagerTestFixtures.stubNoOpMutationGuard(sessions);
        when(sessions.getAuthoritativeSessionState(any(), any(), any())).thenReturn(Maybe.empty());
        return GoogleAdkAgent.builder()
                .runner(runner)
                .sessionManager(sessions)
                .configuredBackendToolNames(Set.of())
                .userIdExtractor(input -> "test-user")
                .pendingCallStore(store)
                .confirmationRequestStore(confirmations)
                .eventEncoder(encoder)
                .build();
    }

    private static CanonicalEventEncoder chunkEncoder() {
        return event -> new EncodedEvent(event, chunkJson(event));
    }

    private static String chunkJson(ToolCallChunkEvent event) {
        return "{\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"" + event.toolCallId()
                + "\",\"toolCallName\":\"" + event.toolCallName()
                + "\",\"delta\":\"" + event.delta().replace("\"", "\\\"") + "\"}";
    }

    private static RunAgentInput agentInput(List<Message> messages, List<Tool> tools, Object forwardedProps) {
        return new RunAgentInput("thread-1", "run-1", Map.of(), messages, tools,
                List.of(new Context("appName", "test-app")), forwardedProps);
    }

    private static RunAgentInput mixedInput() {
        return new RunAgentInput("thread", "run", Map.of(), List.of(new UserMessage("message", "Hi")),
                List.of(new Tool("pick", "Select an item", new ToolParameters(Map.of(), List.of()))),
                List.of(new Context("appName", "app")), Map.of(AdkRunExtensions.FORWARDED_PROPS_KEY,
                        Map.of("rawToolSchemas", List.of(
                                Map.of("position", 0, "name", "pick", "schema", Map.of("type", "object"))))));
    }

    private static ResolvedSession resolvedSession(RunAgentInput input, Set<String> processedIds) {
        Map<String, String> fingerprints = input.messages().stream()
                .filter(message -> processedIds.contains(message.id()))
                .collect(Collectors.toMap(Message::id,
                        com.agui.adk.message.MessageFingerprint::of));
        Session session = Session.builder(input.threadId())
                .appName("test-app")
                .userId("test-user")
                .state(Map.of(PROCESSED_MESSAGE_IDS_KEY, processedIds, FINGERPRINTS_STATE_KEY, fingerprints))
                .build();
        return new ResolvedSession(session, new SessionMapping(
                new SessionMappingKey("test-app", "test-user", input.threadId()), input.threadId()));
    }

    private static ResolvedSession resolvedSession(String sessionId) {
        return new ResolvedSession(Session.builder(sessionId)
                .appName("test-app").userId("test-user").build(), new SessionMapping(
                new SessionMappingKey("test-app", "test-user", "thread"), sessionId));
    }

    private static RunAgentInput confirmationInput(String invocationId, String toolCallId, boolean approved) {
        return RunExtensionSupport.attach(
                new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null),
                new AdkRunExtensions(null, List.of()));
    }

    // ---- ADK event builders ---- //
    private static com.google.adk.events.Event backendCall(String id, String name) {
        return com.google.adk.events.Event.builder().author("model")
                .content(Content.builder().role("model")
                        .parts(Part.builder().functionCall(FunctionCall.builder()
                                .id(id).name(name).args(Map.of()).build()).build())
                        .build()).build();
    }

    private static com.google.adk.events.Event backendResponse(String id, String name) {
        return com.google.adk.events.Event.builder().author("tool")
                .content(Content.builder().role("tool")
                        .parts(Part.builder().functionResponse(FunctionResponse.builder()
                                .id(id).name(name).response(Map.of("ok", true)).build()).build())
                        .build()).build();
    }

    private static com.google.adk.events.Event textEvent(String text) {
        return com.google.adk.events.Event.builder().content(Content.builder().parts(
                Part.fromText(text)).build()).build();
    }

    private static com.google.adk.events.Event nativeConfirmationEvent(String invocationId, String toolCallId) {
        FunctionCall original = FunctionCall.builder().id(toolCallId).name("native-tool").build();
        FunctionCall request = FunctionCall.builder().id(invocationId).name("adk_request_confirmation")
                .args(Map.of("originalFunctionCall", original)).build();
        return com.google.adk.events.Event.builder().content(Content.builder()
                .parts(List.of(Part.builder().functionCall(request).build())).build()).build();
    }

    private static void assertNativeConfirmation(
            Content content, String invocationId, String toolCallId, boolean approved) {
        FunctionResponse response = content.parts().orElseThrow().getFirst().functionResponse().orElseThrow();
        assertThat(content.role()).hasValue("user");
        assertThat(response.id()).hasValue(invocationId);
        assertThat(response.name()).hasValue("adk_request_confirmation");
        assertThat(response.response()).hasValue(Map.of(
                "hint", "", "confirmed", approved, "payload", Map.of("toolCallId", toolCallId)));
    }

    private static com.google.adk.events.Event partialMixedFrontendAndBackendCalls() {
        return com.google.adk.events.Event.builder().author("model").partial(true)
                .content(Content.builder().role("model").parts(
                        Part.builder().functionCall(FunctionCall.builder().id("frontend-a").name("pick")
                                .args(Map.of()).build()).build(),
                        Part.builder().functionCall(FunctionCall.builder().id("backend-b").name("weather")
                                .args(Map.of()).build()).build())
                        .build()).build();
    }

    private static com.google.adk.events.Event finalFrontendCallWithRicherArgs() {
        return com.google.adk.events.Event.builder().author("model")
                .content(Content.builder().role("model")
                        .parts(Part.builder().functionCall(FunctionCall.builder().id("frontend-a")
                                .name("pick").args(Map.of("choice", "rich")).build()).build())
                        .build()).build();
    }

    private static com.google.adk.events.Event partialThoughtEvent(String id) {
        return com.google.adk.events.Event.builder().id(id).author("model").partial(true)
                .content(Content.builder().parts(
                        Part.builder().text("plan ").thought(true).build(),
                        Part.builder().text("steps").thought(true).build()).build()).build();
    }

    private static com.google.adk.events.Event finalThoughtEvent(String id) {
        return com.google.adk.events.Event.builder().id(id).author("model")
                .content(Content.builder().parts(
                        Part.builder().text("plan ").thought(true).build(),
                        Part.builder().text("steps").thought(true).build(),
                        Part.builder().text(" done").thought(true).build(),
                        Part.fromText("answer")).build()).build();
    }

    private static com.google.adk.events.Event stateDeltaEvent(Map<String, Object> delta) {
        return com.google.adk.events.Event.builder()
                .actions(EventActions.builder().stateDelta(delta).build()).build();
    }

    // ---- labeler for deterministic ordering assertions ---- //
    private String toolLabel(Object event) {
        if (event instanceof ToolCallChunkEvent chunk) {
            return "chunk:" + chunk.toolCallId();
        }
        if (event instanceof ToolCallStartEvent start) {
            return "start:" + start.toolCallId();
        }
        if (event instanceof ToolCallArgsEvent args) {
            return "args:" + args.delta();
        }
        if (event instanceof ToolCallEndEvent end) {
            return "end:" + end.toolCallId();
        }
        if (event instanceof ToolCallResultEvent result) {
            return "result:" + result.toolCallId();
        }
        return String.valueOf(event);
    }

    // ---- test plumbing ---- //
    private static List<Event> collect(RecordingSubscriber subscriber) throws InterruptedException {
        assertThat(subscriber.await()).isTrue();
        assertThat(subscriber.error).isNull();
        return subscriber.events;
    }

    private static void collectIgnoringError(Flow.Publisher<Event> publisher) throws InterruptedException {
        CountDownLatch terminal = new CountDownLatch(1);
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                subscription.request(Long.MAX_VALUE);
            }

            @Override
            public void onNext(Event ignored) {
            }

            @Override
            public void onError(Throwable ignored) {
                terminal.countDown();
            }

            @Override
            public void onComplete() {
                terminal.countDown();
            }
        });
        assertThat(terminal.await(5, TimeUnit.SECONDS)).isTrue();
    }

    private static RecordingSubscriber subscribe(Flow.Publisher<Event> publisher) {
        RecordingSubscriber subscriber = new RecordingSubscriber();
        publisher.subscribe(subscriber);
        return subscriber;
    }

    private static final class FakeAdkRunnerClient implements AdkRunnerClient {
        private final AtomicInteger runCount = new AtomicInteger();
        private final List<com.google.adk.events.Event> events = Collections.synchronizedList(new ArrayList<>());
        private final List<Content> contents = new ArrayList<>();
        private String lastUserId;
        private String lastSessionId;
        private RunConfig lastRunConfig;
        private Map<String, Object> lastStateDelta = Map.of();
        private java.util.function.Consumer<RunConfig> beforeEvents = ignored -> { };

        @Override
        public String appName() {
            return "test-app";
        }

        @Override
        public Flowable<com.google.adk.events.Event> runAsync(
                String userId,
                String sessionId,
                Content content,
                RunConfig runConfig,
                Map<String, Object> stateDelta) {
            runCount.incrementAndGet();
            lastUserId = userId;
            lastSessionId = sessionId;
            lastRunConfig = runConfig;
            lastStateDelta = Map.copyOf(stateDelta);
            contents.add(content);
            beforeEvents.accept(runConfig);
            List<com.google.adk.events.Event> emitted = List.copyOf(events);
            events.clear();
            return Flowable.fromIterable(emitted);
        }

        private int runCount() {
            return runCount.get();
        }

        private List<String> visibleToolNames() {
            return AdkAgUiRunContext.from(lastRunConfig).orElseThrow().input().tools().stream()
                    .map(Tool::name)
                    .toList();
        }
    }

    private static final class RecordingSubscriber implements Flow.Subscriber<Event> {
        private final List<Event> events = new ArrayList<>();
        private final CountDownLatch terminal = new CountDownLatch(1);
        private Throwable error;
        private Flow.Subscription subscription;

        @Override
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(Event event) {
            events.add(event);
        }

        @Override
        public void onError(Throwable throwable) {
            error = throwable;
            terminal.countDown();
        }

        @Override
        public void onComplete() {
            terminal.countDown();
        }

        private boolean await() throws InterruptedException {
            return terminal.await(5, TimeUnit.SECONDS);
        }
    }
}
