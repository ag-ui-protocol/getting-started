package com.agui.adk;

import com.google.adk.agents.RunConfig;
import com.agui.adk.auth.AdkAuthRequestAdapter;
import com.agui.adk.capability.AdkAgUiCapabilities;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.context.RunContextFactory;
import com.agui.adk.hitl.AdkConfirmationTranslator;
import com.agui.adk.hitl.ConfirmationRequest;
import com.agui.adk.hitl.ConfirmationRequestStore;
import com.agui.adk.hitl.SessionConfirmationRequestStore;
import com.agui.adk.input.AdkRunExtensions;
import com.agui.adk.input.RunExtensionSupport;
import com.agui.adk.input.RunInputValidator;
import com.agui.adk.input.RunStateSupport;
import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.PreEncodedEvent;
import com.agui.adk.execution.ExecutionCoordinator;
import com.agui.adk.execution.ExecutionKey;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.execution.InProcessExecutionCoordinator;
import com.agui.adk.execution.InProcessGlobalExecutionLimiter;
import com.agui.adk.error.AdkAgUiErrorCode;
import com.agui.adk.error.AdkAgUiException;
import com.agui.adk.hitl.HitlResumePlanner;
import com.agui.adk.hitl.InterruptFactory;
import com.agui.adk.hitl.InterruptStore;
import com.agui.adk.hitl.PendingInterrupt;
import com.agui.adk.hitl.SessionInterruptStore;
import com.agui.adk.hitl.AcceptedResume;
import com.agui.adk.hitl.InterruptGroupClaim;
import com.agui.adk.hitl.InterruptKind;
import com.agui.adk.hitl.InterruptSubmission;
import com.agui.adk.hitl.ResumePayloadValidator;
import com.agui.adk.hitl.PendingCallGroupKey;
import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingCallStore;
import com.agui.adk.hitl.PendingToolCallEmitter;
import com.agui.adk.hitl.PendingStatus;
import com.agui.adk.hitl.PendingResultTransition;
import com.agui.adk.hitl.ResumeClaim;
import com.agui.adk.hitl.SessionPendingCallStore;
import com.agui.adk.hitl.ToolResultNormalizer;
import com.agui.adk.hitl.ToolResultProcessor;
import com.agui.adk.history.AdkSessionMessageHistoryProvider;
import com.agui.adk.history.MessageHistoryProvider;
import com.agui.adk.history.UnseenMessageFilter;
import com.agui.adk.lifecycle.RunLifecycle;
import com.agui.adk.message.MessageReservation;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.message.SessionMessageReservationStore;
import com.agui.adk.processor.MessageChunk;
import com.agui.adk.processor.MessageProcessor;
import com.agui.adk.processor.ToolResult;
import com.agui.adk.translator.EventTranslator;
import com.agui.adk.tool.ToolNameValidator;
import com.agui.adk.tool.FrontendToolExposure;
import com.agui.adk.translator.EventTranslatorFactory;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionCleanupPolicy;
import com.agui.adk.serialization.JacksonAgUiSerializer;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.MessagesSnapshotEvent;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.interrupt.InterruptOutcome;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.tool.Tool;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Flow;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Official AG-UI agent backed by Google ADK.
 *
 * <p>The translation baseline and source comments are ported from Work-m8/ag-ui-4j PR #65 at
 * commit {@code 9b925e6d86b5efe96ba7c50b958da219a1f6cb60}.
 */
public final class GoogleAdkAgent implements Agent, AutoCloseable {

    private static final Logger logger = LoggerFactory.getLogger(GoogleAdkAgent.class);
    private static final String DEFAULT_RUN_ERROR_MESSAGE = "Google ADK run failed";

    private final AdkRunnerClient runner;
    private final SessionManager sessionManager;
    private final RunConfig runConfig;
    private final String staticUserId;
    private final Function<RunAgentInput, String> userIdExtractor;
    private final String staticAppName;
    private final Function<RunAgentInput, String> appNameExtractor;
    private final AdkAgUiOptions options;
    private final com.agui.adk.translator.EventTranslatorFactoryFn eventTranslatorFactory;
    private final MessageProcessor messageProcessor;
    private final ExecutionCoordinator executionCoordinator;
    private final InProcessGlobalExecutionLimiter globalExecutionLimiter;
    private final MessageReservationStore messageReservationStore;
    private final PendingCallStore pendingCallStore;
    private final InterruptStore interruptStore;
    private final InterruptFactory interruptFactory;
    private final ToolResultProcessor toolResultProcessor;
    private final HitlResumePlanner hitlResumePlanner;
    private final ResumePayloadValidator resumePayloadValidator;
    private final CanonicalEventEncoder eventEncoder;
    private final Set<String> configuredBackendToolNames;
    private final AdkConfirmationTranslator confirmationTranslator;
    private final ConfirmationRequestStore confirmationRequestStore;
    private final AdkAuthRequestAdapter authRequestAdapter;
    private final MessageHistoryProvider messageHistoryProvider;
    private final Runnable beforeReservationCancellationClaim;
    private final java.util.function.Function<AdkAgUiRunContext, java.util.Map<String, Object>> metadataEnricher;
    private final Map<String, Object> a2uiConfig;
    private final boolean adkResumable;
    // Runs currently in flight, tracked so close() can cancel their request cancellation tokens
    // and close their request resource registries (Python ADKAgent._active_executions).
    private final java.util.Set<RunHandle> activeRuns = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();

    // Per-instance active-execution registry keyed by (app, user, thread), the Java port of
    // Python ADKAgent._active_executions used by _verify_pending_tool_calls (M-11).
    private final java.util.concurrent.ConcurrentMap<ExecutionKey, Boolean> activeExecutionKeys =
            new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, Object> declaredCapabilities;
    private final boolean capabilitiesDeclared;

    /**
     * Cancels all in-flight runs and releases every process-local resource owned by this agent
     * (Python {@code ADKAgent.close}): each active run's request cancellation token is cancelled
     * and its request resource registry is closed, then the session manager's cleanup task and
     * caches are disposed. Also drops this instance's active-execution registry. Idempotent;
     * safe to call more than once.
     */
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        for (RunHandle handle : activeRuns) {
            try {
                handle.close();
            } catch (RuntimeException error) {
                logger.warn("Failed to close an active run during agent close", error);
            }
        }
        activeRuns.clear();
        activeExecutionKeys.clear();
        sessionManager.dispose();
        Throwable failure = null;
        try {
            runner.close();
        } catch (Throwable error) {
            failure = error;
        }
        try {
            sessionManager.closeServices();
        } catch (Throwable error) {
            if (failure == null) {
                failure = error;
            } else {
                failure.addSuppressed(error);
            }
        }
        if (failure != null) {
            rethrowCloseFailure(failure);
        }
    }

    /**
     * One in-flight run's request-owned cancellation and resources, held by the agent so
     * {@link #close()} can stop active executions (Python {@code ADKAgent._active_executions}).
     */
    private static final class RunHandle implements AutoCloseable {
        private final com.agui.adk.execution.CancellationToken cancellation;
        private final com.agui.adk.context.RequestResourceRegistry resources;

        private RunHandle(
                com.agui.adk.execution.CancellationToken cancellation,
                com.agui.adk.context.RequestResourceRegistry resources) {
            this.cancellation = cancellation;
            this.resources = resources;
        }

        @Override
        public void close() {
            cancellation.cancel();
            resources.close();
        }
    }

    /**
     * Creates an agent from an ADK {@code App}, the canonical composition boundary (Python
     * {@code ADKAgent.from_app}, audit finding M-07): the App bundles the root agent, plugins,
     * resumability, context caching and events compaction into the runner, while the ADK services
     * (session, memory, artifact) and AG-UI options are supplied alongside.
     *
     * @param app ADK application containing the root agent and its configuration
     * @param userIdExtractor per-request user identification
     * @param sessionService ADK session service
     * @param memoryService ADK memory service
     * @param artifactService ADK artifact service
     * @param options framework-neutral bridge options
     * @return a configured agent executing the App on the public run path
     */
    public static GoogleAdkAgent fromApp(
            com.google.adk.apps.App app,
            Function<RunAgentInput, String> userIdExtractor,
            com.google.adk.sessions.BaseSessionService sessionService,
            com.google.adk.memory.BaseMemoryService memoryService,
            com.google.adk.artifacts.BaseArtifactService artifactService,
            AdkAgUiOptions options) {
        Objects.requireNonNull(app, "app");
        Objects.requireNonNull(sessionService, "sessionService");
        Objects.requireNonNull(memoryService, "memoryService");
        Objects.requireNonNull(artifactService, "artifactService");
        Objects.requireNonNull(options, "options");
        com.google.adk.runner.Runner runner = com.google.adk.runner.Runner.builder()
                .app(app)
                .sessionService(sessionService)
                .memoryService(memoryService)
                .artifactService(artifactService)
                .build();
        SessionManager manager = new SessionManager(
                sessionService,
                memoryService,
                new com.agui.adk.session.InMemoryThreadSessionMappingStore(),
                options);
        JacksonAgUiSerializer serializer = new JacksonAgUiSerializer(new ObjectMapper());
        return GoogleAdkAgent.builder()
                .runner(new GoogleAdkRunnerClient(runner))
                .sessionManager(manager)
                .userIdExtractor(userIdExtractor)
                .eventEncoder(event -> new com.agui.adk.encoding.EncodedEvent(
                        event, serializer.serialize(event)))
                .configuredBackendToolNames(Set.of())
                .adkResumable(app.resumabilityConfig() != null && app.resumabilityConfig().isResumable())
                .options(options)
                .build();
    }

    /**
     * Creates a builder for the official agent adapter.
     *
     * @return new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Creates an adapter with the supplied baseline collaborators.
     *
     * @param builder configured builder
     */
    private GoogleAdkAgent(Builder builder) {
        runner = Objects.requireNonNull(builder.runner, "runner");
        sessionManager = Objects.requireNonNull(builder.sessionManager, "sessionManager");
        runConfig = Objects.requireNonNull(builder.runConfig, "baseRunConfig");
        staticUserId = builder.staticUserId;
        userIdExtractor = builder.userIdExtractor;
        staticAppName = builder.staticAppName;
        appNameExtractor = builder.appNameExtractor;
        options = Objects.requireNonNull(builder.options, "options");
        eventTranslatorFactory = Objects.requireNonNull(builder.eventTranslatorFactory, "eventTranslatorFactory");
        messageProcessor = MessageProcessor.INSTANCE;
        executionCoordinator = Objects.requireNonNull(builder.executionCoordinator, "executionCoordinator");
        globalExecutionLimiter = new InProcessGlobalExecutionLimiter(options.globalConcurrencyLimit());
        messageReservationStore = Objects.requireNonNullElseGet(
                builder.messageReservationStore, SessionMessageReservationStore::new);
        sessionManager.registerMessageReservationStore(messageReservationStore);
        pendingCallStore = Objects.requireNonNullElseGet(builder.pendingCallStore, SessionPendingCallStore::new);
        interruptStore = Objects.requireNonNullElseGet(builder.interruptStore, SessionInterruptStore::new);
        interruptFactory = new InterruptFactory();
        toolResultProcessor = new ToolResultProcessor(pendingCallStore, new ToolResultNormalizer());
        hitlResumePlanner = new HitlResumePlanner();
        resumePayloadValidator = new ResumePayloadValidator();
        eventEncoder = builder.eventEncoder;
        configuredBackendToolNames = Set.copyOf(builder.configuredBackendToolNames);
        confirmationTranslator = new AdkConfirmationTranslator();
        confirmationRequestStore = Objects.requireNonNullElseGet(
                builder.confirmationRequestStore, SessionConfirmationRequestStore::new);
        authRequestAdapter = builder.authRequestAdapter;
        messageHistoryProvider = Objects.requireNonNullElseGet(
                builder.messageHistoryProvider, AdkSessionMessageHistoryProvider::new);
        beforeReservationCancellationClaim = Objects.requireNonNull(
                builder.beforeReservationCancellationClaim, "beforeReservationCancellationClaim");
        metadataEnricher = Objects.requireNonNull(
                builder.metadataEnricher, "metadataEnricher");
        if (builder.sessionCleanupPolicy != null) {
            sessionManager.configureCleanupPolicy(builder.sessionCleanupPolicy);
        }
        a2uiConfig = builder.a2uiConfig;
        adkResumable = builder.adkResumable;
        declaredCapabilities = builder.declaredCapabilities;
        capabilitiesDeclared = builder.capabilitiesDeclared;
    }

    /**
     * Runs the adapter lazily and exposes official events through JDK Flow.
     *
     * <p>The returned publisher is cold: in accordance with the official Agent contract, every
     * subscription starts one independent run. It is not a replayable single-run handle.
     *
     * @param input official AG-UI input
     * @return cancellation-aware JDK publisher
     */
    @Override
    public Flow.Publisher<Event> run(RunAgentInput input) {
        Objects.requireNonNull(input, "input");
        Flowable<Event> events = Flowable.defer(() -> resolveUserIdAndRun(input));
        return RxFlowAdapters.toFlowPublisher(events);
    }

    /**
     * Returns narrowly scoped bridge capabilities not represented by AG-UI 0.2.0 itself.
     *
     * @return detached capability map, or {@code null} when the application declared none
     */
    public Map<String, Object> capabilities() {
        return capabilitiesDeclared
                ? AdkAgUiCapabilities.snapshot(declaredCapabilities)
                : null;
    }

    /**
     * Replays unresolved frontend calls using the same Task 5 app/user/thread session mapping.
     *
     * <p>The persisted official event is returned directly: this boundary never invokes the
     * encoder, so the paired prevalidated JSON retained by the store is not regenerated.
     *
     * @param appName ADK application identity
     * @param userId authenticated principal identity
     * @param threadId AG-UI thread identity
     * @param knownToolCallIds client-visible calls to suppress
     * @return unresolved official events for the resolved session
     */
    public Flow.Publisher<Event> replayPendingCalls(
            String appName, String userId, String threadId, Set<String> knownToolCallIds) {
        Set<String> known = knownToolCallIds == null ? Set.of() : Set.copyOf(knownToolCallIds);
        return RxFlowAdapters.toFlowPublisher(
                Flowable.defer(() -> replayPendingCallsInternal(appName, userId, threadId, known)));
    }

    /**
     * Resolves the durable scope before reading pending calls.
     *
     * @param appName ADK application identity
     * @param userId authenticated principal identity
     * @param threadId AG-UI thread identity
     * @param knownToolCallIds client-visible calls to suppress
     * @return pending official events or a stable persistence error
     */
    private Flowable<Event> replayPendingCallsInternal(
            String appName, String userId, String threadId, Set<String> knownToolCallIds) {
        try {
            PendingCallStore store = Objects.requireNonNull(pendingCallStore, "pendingCallStore");
            return sessionManager.findExistingSession(appName, userId, threadId)
                    .flatMapPublisher(resolved -> {
                        PendingCallScope scope = new PendingCallScope(appName, userId, resolved.session().id());
                        Flowable<Event> calls = store.pending(scope)
                                .filter(call -> call.status() == PendingStatus.PENDING)
                                .filter(call -> !knownToolCallIds.contains(call.key().toolCallId()))
                                .map(call -> (Event) replayEvent(call.event(), call.json()));
                        Flowable<Event> outcome = interruptStore.outstanding(scope).toList()
                                .filter(interrupts -> !interrupts.isEmpty())
                                .map(interrupts -> (Event) new RunFinishedEvent(
                                        threadId, interrupts.getFirst().originRunId(),
                                        new InterruptOutcome(interrupts.stream()
                                                .map(PendingInterrupt::interrupt).toList()),
                                        null, null, null))
                                .toFlowable();
                        return calls.concatWith(outcome);
                    })
                    .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE));
        } catch (RuntimeException error) {
            return Flowable.just(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE));
        }
    }

    /**
     * Attaches persisted exact JSON to an official event at the public replay boundary.
     *
     * @param event stored official event
     * @param json exact retained wire representation
     * @return official event carrying the pre-encoded transport representation
     */
    private static ToolCallChunkEvent replayEvent(ToolCallChunkEvent event, String json) {
        return new ToolCallChunkEvent(event.toolCallId(), event.toolCallName(), event.parentMessageId(), event.delta(),
                event.timestamp(), new PreEncodedEvent(event, json));
    }

    /**
     * Resolves the baseline user identifier when the publisher is subscribed.
     *
     * @param input official AG-UI input
     * @return event stream
     */
    private Flowable<Event> resolveUserIdAndRun(RunAgentInput input) {
        try {
            String userId = resolveUserId(input);
            String appName = resolveAppName(input);
            if (userId == null || userId.isBlank() || appName == null || appName.isBlank()) {
                return rejectedLifecycle(input, AdkAgUiErrorCode.INVALID_RUN_INPUT, "Invalid run input");
            }
            return runInternal(input, appName, userId);
        } catch (Exception error) {
            return rejectedLifecycle(input, AdkAgUiErrorCode.INVALID_RUN_INPUT, "Invalid run input");
        }
    }

    /**
     * Resolves the configured Java user identifier: static {@code user_id}, then the per-request
     * {@code user_id_extractor}. The canonical Python fallback remains unavailable because the
     * established Java builder contract requires an explicit identity source.
     *
     * @param input official AG-UI input
     * @return resolved user identifier, possibly null or blank
     */
    private String resolveUserId(RunAgentInput input) {
        if (staticUserId != null && !staticUserId.isBlank()) {
            return staticUserId;
        }
        if (userIdExtractor != null) {
            return userIdExtractor.apply(input);
        }
        return null;
    }

    /**
     * Resolves the Google ADK application name with Python {@code ADKAgent._get_app_name}
     * precedence: static {@code app_name}, then the per-request {@code app_name_extractor},
     * then the runner's application name (Python's agent-name default).
     *
     * @param input official AG-UI input
     * @return resolved application name
     */
    private String resolveAppName(RunAgentInput input) {
        if (staticAppName != null && !staticAppName.isBlank()) {
            return staticAppName;
        }
        if (appNameExtractor != null) {
            return appNameExtractor.apply(input);
        }
        return runner.appName();
    }

    /**
     * Emits a stable accepted lifecycle for failures before a request context can exist.
     *
     * @param input public request whose identifiers define the public lifecycle
     * @param code stable public error code
     * @param message stable public error message
     * @return one start followed by one coded error
     */
    private static Flowable<Event> rejectedLifecycle(
            RunAgentInput input, AdkAgUiErrorCode code, String message) {
        return RunLifecycle.forRun(input.threadId(), input.runId())
                .apply(Flowable.error(new AdkAgUiException(code, message)));
    }

    /**
     * Runs the imported lifecycle after validating the resolved user identifier.
     *
     * @param input official AG-UI input
     * @param appName resolved application identifier
     * @param userId resolved user identifier
     * @return event stream
     */
    private Flowable<Event> runInternal(RunAgentInput input, String appName, String userId) {
        if (userId == null || userId.isBlank()) {
            return rejectedLifecycle(input, AdkAgUiErrorCode.INVALID_RUN_INPUT, "Invalid run input");
        }
        return Flowable.defer(() -> {
            try {
                RunContext provisional = new RunContext(input, appName, userId);
                RunContextFactory factory = new RunContextFactory(
                        provisional.appName(), provisional.userId(), provisional.sessionId(),
                        new RunInputValidator(), metadataEnricher);
                RunConfig provisionalConfig = factory.createRequestConfig(runConfig, input);
                AdkAgUiRunContext provisionalContext = AdkAgUiRunContext.from(provisionalConfig).orElseThrow();
                ToolNameValidator.validatePairs(
                        provisionalContext.input().tools(), provisionalContext.rawToolSchemas());
                ToolNameValidator.validateNoBackendCollisions(
                        provisionalContext.input().tools(), configuredBackendToolNames);
                Map<String, Object> requestState = RunStateSupport.asMap(input.state());
                if (eventEncoder == null && !provisionalContext.input().tools().isEmpty()) {
                    return rejectedLifecycle(input, AdkAgUiErrorCode.ENCODING_ERROR, "Event encoding failed");
                }
                AdkRunExtensions.RequestAction action = RunExtensionSupport.extract(input)
                        .map(AdkRunExtensions::action)
                        .orElse(null);
                if (!input.resume().isEmpty()) {
                    return withLifecycle(provisional, provisionalContext, routeOfficialResume(
                            input, provisional, provisionalContext, action));
                }
                if (action instanceof AdkRunExtensions.AuthAction authAction) {
                    return withLifecycle(provisional, provisionalContext, delegateAuth(authAction, provisionalContext));
                }
                return sessionManager.resolveSession(provisionalContext)
                        .flatMapPublisher(resolvedSession -> {
                            RunConfig requestRunConfig = new RunContextFactory(
                                    provisional.appName(), provisional.userId(), resolvedSession.session().id(),
                                    new RunInputValidator(), metadataEnricher)
                                    .createRequestConfig(runConfig, input);
                            AdkAgUiRunContext context = AdkAgUiRunContext.from(requestRunConfig).orElseThrow();
                            ExecutionKey key = new ExecutionKey(
                                    context.appName(), context.userId(), context.threadId());
                            // Python _ensure_session_exists verifies persisted pending tool-call
                            // markers on first local access of the session (M-11): stale markers
                            // left by a crashed middleware are cleared when no execution is active
                            // on this instance. A manager without the verification seam (e.g. a
                            // test double) makes this a best-effort no-op.
                            Completable pendingCallVerification = sessionManager.verifyPendingToolCalls(
                                    context.appName(), context.userId(),
                                    resolvedSession.session().id(), context.threadId(),
                                    () -> activeExecutionKeys.containsKey(key));
                            if (pendingCallVerification == null) {
                                pendingCallVerification = Completable.complete();
                            }
                            return withLifecycle(provisional, context,
                                    pendingCallVerification
                                            .andThen(sessionManager.acquireExecutionMutationGuard(resolvedSession.session())
                                            .flatMapPublisher(sessionGuard -> {
                                                SharedSessionGuard guardOwner = new SharedSessionGuard(sessionGuard);
                                                Completable initializeState = sessionManager.initializeSessionState(
                                                        resolvedSession.session(), requestState, false);
                                                if (initializeState == null) {
                                                    initializeState = Completable.complete();
                                                }
                                                return guardOwner.own(initializeState.andThen(Flowable.defer(() ->
                                                        eventsWithCompleteHistorySnapshot(
                                                                context, requestRunConfig, input, resolvedSession,
                                                                key, guardOwner))))
                                                    .onErrorResumeNext(error -> Flowable.just(error
                                                            instanceof TerminalRunErrorException terminal
                                                            ? terminal.event()
                                                            : new RunErrorEvent(
                                                                    stableRunErrorMessage(error),
                                                                    error instanceof AdkAgUiException bridgeError
                                                                            ? bridgeError.code().name()
                                                                            : AdkAgUiErrorCode.ADK_EXECUTION_FAILURE.name(),
                                                                    null,
                                                                    null)));
                                            })));
                        })
                        .doOnError(error -> logger.error(
                                "Failed to resolve or execute session for appName '{}'",
                                provisional.appName(), error))
                        .onErrorResumeNext(error -> withLifecycle(
                                provisional, provisionalContext, Flowable.error(error)));
            } catch (Exception error) {
                logger.error("Failed to prepare reactive agent run", error);
                boolean duplicateTool = error instanceof IllegalArgumentException
                        && error.getMessage() != null
                        && error.getMessage().startsWith("DUPLICATE_TOOL_NAME");
                return rejectedLifecycle(
                        input,
                        duplicateTool ? AdkAgUiErrorCode.DUPLICATE_TOOL_NAME : AdkAgUiErrorCode.INVALID_RUN_INPUT,
                        duplicateTool ? "Duplicate tool name" : "Invalid run input");
            }
        });
    }

    /**
     * Routes the official resume field before either private actions or historical messages.
     *
     * <p>Phase 4 exposes and validates the official seam but intentionally fails closed until the
     * Phase 6 store owns opaque interrupt IDs, scoped correlation, atomic claims, and cancellation
     * policy. This prevents resume-only requests from being silently treated as empty runs while
     * preserving the historical ToolMessage path for empty resume lists.
     *
     * @param input official request containing resume entries
     * @param lifecycleContext public run identity
     * @param requestContext provisional request-owned context
     * @param action optional private auth action
     * @return stable lifecycle rejection without session or HITL-store mutation
     */
    private Flowable<Event> routeOfficialResume(
            RunAgentInput input,
            RunContext lifecycleContext,
            AdkAgUiRunContext requestContext,
            AdkRunExtensions.RequestAction action) {
        if (action != null || input.messages().stream()
                .anyMatch(com.agui.community.core.message.ToolMessage.class::isInstance)) {
            return rejectedLifecycle(input, AdkAgUiErrorCode.INVALID_RESUME,
                    "Official resume cannot be mixed with a legacy HITL submission");
        }
        return io.reactivex.rxjava3.core.Maybe.defer(() -> {
                    try {
                        return sessionManager.findExistingSession(
                                lifecycleContext.appName(), lifecycleContext.userId(), requestContext.threadId());
                    } catch (RuntimeException error) {
                        return io.reactivex.rxjava3.core.Maybe.error(new AdkAgUiException(
                                AdkAgUiErrorCode.SESSION_FAILURE, "Session failure", error));
                    }
                })
                .switchIfEmpty(io.reactivex.rxjava3.core.Maybe.error(new AdkAgUiException(
                        AdkAgUiErrorCode.UNKNOWN_INTERRUPT, "Unknown interrupt")))
                .flatMapPublisher(session -> {
                    RunConfig requestRunConfig = new RunContextFactory(
                            lifecycleContext.appName(), lifecycleContext.userId(), session.session().id(),
                            new RunInputValidator(), metadataEnricher)
                            .createRequestConfig(runConfig, input);
                    AdkAgUiRunContext context = AdkAgUiRunContext.from(requestRunConfig).orElseThrow();
                    PendingCallScope scope = new PendingCallScope(
                            context.appName(), context.userId(), session.session().id());
                    List<Resume> resumes = List.copyOf(input.resume());
                    return interruptStore.lookup(scope, resumes.stream().map(Resume::interruptId).toList())
                            .flatMapPublisher(outstanding -> {
                        try {
                            Set<String> ids = new java.util.HashSet<>();
                            for (int index = 0; index < resumes.size(); index++) {
                                Resume resume = resumes.get(index);
                                if (resume.interruptId().isBlank() || !ids.add(resume.interruptId())) {
                                    throw new AdkAgUiException(AdkAgUiErrorCode.INVALID_RESUME,
                                            "Invalid resume request");
                                }
                                PendingInterrupt pending = outstanding.get(index);
                                resumePayloadValidator.validate(
                                        resumePayloadValidator.compile(pending.interrupt().responseSchema()), resume);
                            }
                        } catch (AdkAgUiException error) {
                            return Flowable.error(error);
                        } catch (IllegalArgumentException error) {
                            return Flowable.error(new AdkAgUiException(
                                    AdkAgUiErrorCode.INVALID_RESUME, "Invalid resume payload", error));
                        }
                        return interruptStore.submit(scope, resumes).flatMapPublisher(submission -> {
                            if (submission instanceof InterruptSubmission.Pending pending) {
                                if (pending.outstanding().isEmpty()) {
                                    return Flowable.error(new AdkAgUiException(
                                            AdkAgUiErrorCode.PERSISTENCE_FAILURE, "Empty interrupt outcome"));
                                }
                                return Flowable.just((Event) new RunFinishedEvent(
                                        context.threadId(), context.runId(),
                                        new InterruptOutcome(pending.outstanding()), null, null, null));
                            }
                            if (submission instanceof InterruptSubmission.Cancelled) {
                                return Flowable.just((Event) codedRunError(AdkAgUiErrorCode.HITL_CANCELLED));
                            }
                            if (submission instanceof InterruptSubmission.Duplicate) {
                                return Flowable.empty();
                            }
                            return continueOfficialInterruptClaim(
                                    context, requestRunConfig, session,
                                    ((InterruptSubmission.Claimed) submission).claim());
                        });
                    });
                })
                .onErrorResumeNext(error -> {
                    if (error instanceof AdkAgUiException) return Flowable.error(error);
                    if (error instanceof IllegalArgumentException) {
                        return Flowable.error(new AdkAgUiException(
                                AdkAgUiErrorCode.UNKNOWN_INTERRUPT, "Unknown interrupt", error));
                    }
                    return Flowable.error(new AdkAgUiException(
                            AdkAgUiErrorCode.PERSISTENCE_FAILURE, "Persistence failure", error));
                });
    }

    /**
     * Continues one atomically claimed official interrupt group.
     * @param context resolved request context
     * @param requestRunConfig request-specific configuration
     * @param session resolved session
     * @param claim complete interrupt claim
     * @return continuation events
     */
    private Flowable<Event> continueOfficialInterruptClaim(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            ResolvedSession session,
            InterruptGroupClaim claim) {
        ExecutionKey key = new ExecutionKey(context.appName(), context.userId(), context.threadId());
        return acquireExecutionLease(key, context.cancellation()).flatMapPublisher(lease ->
                interruptStore.finalizationPending(claim).flatMapPublisher(recovery -> {
                    java.util.concurrent.atomic.AtomicBoolean marked = new java.util.concurrent.atomic.AtomicBoolean(recovery);
                    ReservationFinalizer finalizer = new ReservationFinalizer(
                            () -> (recovery ? Completable.complete() : interruptStore.markFinalizationPending(claim)
                                    .doOnComplete(() -> marked.set(true))).andThen(interruptStore.complete(claim)),
                            () -> marked.get() ? interruptStore.releaseFinalization(claim) : interruptStore.release(claim),
                            lease);
                    if (recovery) {
                        return finalizer.finalizeDurably().<Event>toFlowable()
                                .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE));
                    }
                    Flowable<Event> execution = Flowable.defer(() -> {
                        com.google.genai.types.Content continuation = officialContinuation(claim);
                        EventTranslator translator = createTranslator(context, session);
                        A2uiRunEvents a2ui = runWithA2uiWiring(
                                context, requestRunConfig, continuation, Map.of());
                        return translateAndPersistConfirmations(context, a2ui.adk(), translator)
                                .mergeWith(a2ui.nested());
                    }).onErrorResumeNext(error -> finalizer.rollbackAfterRunnerFailure().andThen(
                            Flowable.just(codedRunError(AdkAgUiErrorCode.ADK_EXECUTION_FAILURE))));
                    return execution.concatWith(Flowable.defer(() -> finalizer.finalizeDurably()
                                    .<Event>toFlowable()
                                    .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE))))
                            .doOnCancel(finalizer::cancel);
                }));
    }

    /**
     * Builds the provider continuation for a complete official interrupt claim.
     * @param claim complete interrupt claim
     * @return provider continuation content
     */
    private com.google.genai.types.Content officialContinuation(InterruptGroupClaim claim) {
        if (claim.interrupts().stream().allMatch(i -> i.kind() == InterruptKind.ADK_CONFIRMATION)) {
            PendingInterrupt interrupt = claim.interrupts().getFirst();
            Object payload = claim.resumes().getFirst().payload();
            boolean approved = payload instanceof Boolean value ? value
                    : payload instanceof Map<?, ?> map && Boolean.TRUE.equals(map.get("approved"));
            AdkConfirmationTranslator.Decision decision = approved
                    ? confirmationTranslator.approve(interrupt.adkInvocationId(), interrupt.toolCallId())
                    : confirmationTranslator.reject(interrupt.adkInvocationId(), interrupt.toolCallId());
            return confirmationTranslator.continuation(decision);
        }
        if (claim.interrupts().stream().anyMatch(i -> i.kind() != InterruptKind.FRONTEND_TOOL)) {
            throw new AdkAgUiException(AdkAgUiErrorCode.INVALID_RESUME,
                    "Mixed interrupt continuation kinds");
        }
        List<com.google.genai.types.Part> parts = new java.util.ArrayList<>();
        for (int index = 0; index < claim.interrupts().size(); index++) {
            PendingInterrupt interrupt = claim.interrupts().get(index);
            AcceptedResume resume = claim.resumes().get(index);
            Object payload = resume.payload();
            Map<String, Object> response = payload instanceof Map<?, ?> map
                    ? map.entrySet().stream().filter(e -> e.getKey() instanceof String)
                            .collect(Collectors.toMap(e -> (String) e.getKey(), Map.Entry::getValue))
                    : java.util.Collections.singletonMap("result", payload);
            parts.add(com.google.genai.types.Part.builder().functionResponse(
                    com.google.genai.types.FunctionResponse.builder()
                            .id(interrupt.toolCallId()).name(interrupt.toolName())
                            .response(response).build()).build());
        }
        return com.google.genai.types.Content.builder().role("user").parts(parts).build();
    }

    /**
     * Delegates a request-local auth input without creating or mutating an ADK session.
     *
     * @param action immutable auth action
     * @param context immutable provisional request context
     * @return adapter events or a stable unsupported error
     */
    private Flowable<Event> delegateAuth(
            AdkRunExtensions.AuthAction action, AdkAgUiRunContext context) {
        if (authRequestAdapter == null) {
            return Flowable.just(new RunErrorEvent(
                    "Unsupported auth request", AdkAgUiErrorCode.UNSUPPORTED_AUTH_REQUEST.name(), null, null));
        }
        return Flowable.defer(() -> authRequestAdapter.handle(new AdkAuthRequestAdapter.Request(
                action.requestId(), action.input(), context)));
    }



    /**
     * Persists native ADK confirmation correlations before their events are translated externally.
     *
     * @param context resolved principal-scoped context
     * @param events native ADK events
     * @param translator event translator for this run
     * @return translated events
     */
    private Flowable<Event> translateAndPersistConfirmations(
            AdkAgUiRunContext context,
            Flowable<com.google.adk.events.Event> events,
            EventTranslator translator) {
        PendingCallScope scope = new PendingCallScope(context.appName(), context.userId(), context.sessionId());
        PendingToolCallEmitter emitter = new PendingToolCallEmitter(
                pendingCallStore, eventEncoder, context.toolCallLedger(),
                interruptStore, interruptFactory, context.runId());
        FrontendToolExposure exposure = FrontendToolExposure.from(context);
        exposure.reset(context.input().tools().stream().map(Tool::name).toList());
        translator.configureFrontendToolPersistence(
                scope, context.invocationId(), exposure.names(), emitter);
        LroRunLoopState lro = new LroRunLoopState();
        Flowable<com.google.adk.events.Event> routed = events.takeUntil(event -> !adkResumable
                && ((lro.drainingForPersistence && !event.partial().orElse(false))
                        || (!event.partial().orElse(false) && hasLongRunningFunctionCall(event))));
        return routed.concatMap(event -> persistConfirmationRequest(context, scope, event)
                        .andThen(translateProviderEvent(event, translator, lro)))
                .concatWith(Flowable.defer(() -> emitDurableHitlEnds(context, emitter)))
                .concatWith(Flowable.defer(() -> persistLroIdRemap(context, translator).toFlowable()))
                .concatWith(Flowable.defer(() -> translator.apply(Flowable.empty())))
                .concatMap(GoogleAdkAgent::failOnTerminalRunError);
    }

    /**
     * Persists native/backend HITL correlation before exposing retained TOOL_CALL_END events.
     *
     * @param context current run identity
     * @param emitter durability visibility boundary
     * @return retained ends after their correlation commit
     */
    private Flowable<Event> emitDurableHitlEnds(
            AdkAgUiRunContext context, PendingToolCallEmitter emitter) {
        Set<String> deferredIds = emitter.deferredEndIds();
        if (deferredIds.isEmpty()) {
            return Flowable.empty();
        }
        Completable durableCommit = sessionManager.getAuthoritativeSession(
                        context.appName(), context.userId(), context.sessionId())
                .switchIfEmpty(io.reactivex.rxjava3.core.Maybe.error(
                        new IllegalStateException("authoritative session unavailable")))
                .flatMapCompletable(session -> {
                    Set<String> merged = new java.util.LinkedHashSet<>();
                    Object existing = session.state().get("pendingToolCallIds");
                    if (existing instanceof java.util.Collection<?> values) {
                        values.stream().filter(String.class::isInstance)
                                .map(String.class::cast).forEach(merged::add);
                    }
                    merged.addAll(deferredIds);
                    return sessionManager.updateSessionState(
                            session, Map.of("pendingToolCallIds", Set.copyOf(merged)));
                });
        return emitter.emitDeferredEndsAfter(durableCommit);
    }

    /**
     * Persists captured LRO ID remaps only after the provider runner has completed.
     *
     * @param context current run identity
     * @param translator run translator retaining captured remaps
     * @return persistence completion
     */
    private Completable persistLroIdRemap(AdkAgUiRunContext context, EventTranslator translator) {
        Map<String, String> captured = translator.drainLroIdRemap();
        if (captured.isEmpty()) {
            return Completable.complete();
        }
        return sessionManager.getAuthoritativeSession(context.appName(), context.userId(), context.sessionId())
                .flatMapCompletable(session -> {
                    Map<String, String> merged = new java.util.LinkedHashMap<>();
                    Object existing = session.state().get("lro_tool_call_id_remap");
                    if (existing instanceof Map<?, ?> map) {
                        map.forEach((key, value) -> {
                            if (key instanceof String source && value instanceof String target) {
                                merged.put(source, target);
                            }
                        });
                    }
                    merged.putAll(captured);
                    return sessionManager.setStateValue(session, "lro_tool_call_id_remap", merged);
                })
                .onErrorComplete(error -> {
                    logger.warn("Failed to persist LRO identifier remap for session '{}'", context.sessionId(), error);
                    return true;
                });
    }

    /**
     * Routes one provider event through the ordinary or dedicated LRO translation path.
     *
     * @param event provider event
     * @param translator run translator
     * @param state LRO drain state
     * @return translated official events
     */
    private Flowable<Event> translateProviderEvent(
            com.google.adk.events.Event event, EventTranslator translator, LroRunLoopState state) {
        if (state.drainingForPersistence) {
            Flowable<Event> text = translator.translateTextOnly(event);
            if (!event.partial().orElse(false)) {
                translator.capturePersistedLroIds(event);
                state.drainingForPersistence = false;
                state.hardStopped = true;
            }
            return text;
        }
        if (state.hardStopped) {
            return Flowable.empty();
        }
        if (!hasLongRunningFunctionCall(event)) {
            return translator.translate(event);
        }
        state.partialEvent = event;
        if (!adkResumable && event.partial().orElse(false)) {
            state.drainingForPersistence = true;
        } else if (!adkResumable) {
            translator.capturePersistedLroIds(event);
            state.hardStopped = true;
        }
        return translator.translateLongRunningEvent(event);
    }

    /**
     * Whether the event has a function call whose id is included in its LRO guidance.
     *
     * @param event provider event
     * @return true when the event contains a guided LRO call
     */
    private static boolean hasLongRunningFunctionCall(com.google.adk.events.Event event) {
        java.util.Set<String> ids = event.longRunningToolIds().orElse(java.util.Set.of());
        return !ids.isEmpty() && event.functionCalls().stream()
                .anyMatch(call -> call.id().map(ids::contains).orElse(false));
    }

    /** Mutable state for the non-resumable partial-to-persisted LRO drain. */
    private static final class LroRunLoopState {
        private boolean drainingForPersistence;
        private boolean hardStopped;
        private com.google.adk.events.Event partialEvent;
    }

    /**
     * Fetches the authoritative session after normal ADK completion, bypassing the per-execution
     * read cache, then lets the translator reapply accumulated predictive state and protected-key
     * filtering before emission.
     *
     * @param context resolved run/session identity
     * @param translator translator retaining accumulated predictive state
     * @return zero or one authoritative state snapshot
     */
    private Flowable<Event> authoritativeStateSnapshot(
            AdkAgUiRunContext context, EventTranslator translator) {
        return Flowable.defer(() -> {
            io.reactivex.rxjava3.core.Maybe<Map<String, Object>> refreshed =
                    sessionManager.getAuthoritativeSessionState(
                            context.appName(), context.userId(), context.sessionId());
            if (refreshed == null) {
                refreshed = io.reactivex.rxjava3.core.Maybe.empty();
            }
            return refreshed.defaultIfEmpty(Map.of())
                    .flatMapPublisher(translator::finalStateSnapshot);
        });
    }

    /**
     * Turns a translator-produced terminal event into a stream failure before a reservation can
     * reach its success finalizer.
     *
     * @param event translated official event
     * @return the event, or a failure retaining the stable terminal error code
     */
    private static Flowable<Event> failOnTerminalRunError(Event event) {
        if (event instanceof RunErrorEvent runError) {
            return Flowable.error(new TerminalRunErrorException(runError));
        }
        return Flowable.just(event);
    }

    /** Retains the complete translator terminal while traversing reservation cleanup. */
    private static final class TerminalRunErrorException extends RuntimeException {
        private final RunErrorEvent event;

        private TerminalRunErrorException(RunErrorEvent event) {
            super(event.message());
            this.event = event;
        }

        private RunErrorEvent event() { return event; }
    }

    /**
     * Stores the native confirmation call ID and its original provider call ID when present.
     *
     * @param context current public run context
     * @param scope resolved principal-scoped session identity
     * @param event native ADK event
     * @return persistence completion, or no-op for non-confirmation events
     */
    private io.reactivex.rxjava3.core.Completable persistConfirmationRequest(
            AdkAgUiRunContext context,
            PendingCallScope scope,
            com.google.adk.events.Event event) {
        List<PendingInterrupt> interrupts = event.content()
                .flatMap(com.google.genai.types.Content::parts)
                .stream().flatMap(List::stream)
                .map(com.google.genai.types.Part::functionCall)
                .filter(java.util.Optional::isPresent)
                .map(java.util.Optional::get)
                .filter(call -> call.name().filter("adk_request_confirmation"::equals).isPresent())
                .flatMap(call -> call.args().flatMap(args -> originalToolCallId(args.get("originalFunctionCall"))
                        .flatMap(toolCallId -> call.id().map(invocationId -> {
                            PendingCallGroupKey group = new PendingCallGroupKey(
                                    scope, context.invocationId() + ":confirmation:" + invocationId);
                            return interruptFactory.confirmation(
                                    group, context.runId(), toolCallId, invocationId,
                                    args.get("hint") instanceof String hint ? hint : null,
                                    Map.of(
                                            "$schema", "https://json-schema.org/draft/2020-12/schema",
                                            "type", "object",
                                            "required", List.of("approved"),
                                            "properties", Map.of(
                                                    "approved", Map.of("type", "boolean")),
                                            "additionalProperties", false));
                        }))).stream())
                .toList();
        if (interrupts.isEmpty()) {
            return io.reactivex.rxjava3.core.Completable.complete();
        }
        io.reactivex.rxjava3.core.Completable legacy = Flowable.fromIterable(interrupts)
                .concatMapCompletable(interrupt -> confirmationRequestStore.persist(new ConfirmationRequest(
                        scope, interrupt.adkInvocationId(), interrupt.toolCallId())));
        return legacy.andThen(interruptStore.persistGroup(interrupts));
    }

    /**
     * Extracts an original provider call ID from ADK's native confirmation request payload.
     *
     * @param originalFunctionCall ADK-generated original function-call representation
     * @return provider call ID when represented by the ADK model or a JSON-like map
     */
    private static java.util.Optional<String> originalToolCallId(Object originalFunctionCall) {
        if (originalFunctionCall instanceof com.google.genai.types.FunctionCall functionCall) {
            return functionCall.id();
        }
        if (originalFunctionCall instanceof Map<?, ?> map) {
            Object id = map.get("id");
            return id instanceof String value && !value.isBlank()
                    ? java.util.Optional.of(value)
                    : java.util.Optional.empty();
        }
        return java.util.Optional.empty();
    }

    /**
     * Acquires same-key coordination then an immediate process-local global admission slot.
     *
     * @param key execution identity
     * @param cancellation request-local cancellation token
     * @return a lease that releases both admissions
     */
    private Single<ExecutionLease> acquireExecutionLease(
            ExecutionKey key, com.agui.adk.execution.CancellationToken cancellation) {
        return executionCoordinator.acquire(key, cancellation).flatMap(keyLease -> {
            ExecutionLease globalLease = globalExecutionLimiter.tryAcquire();
            if (globalLease == null) {
                keyLease.close();
                return Single.error(new AdkAgUiException(
                        AdkAgUiErrorCode.CONCURRENCY_LIMIT, "Global execution concurrency limit reached"));
            }
            return Single.just(() -> {
                globalLease.close();
                keyLease.close();
            });
        });
    }

    /**
     * Combines the execution coordinator lease with the manager-owned session mutation guard.
     *
     * @param executionLease same-key and global admission lease
     * @param sessionGuard session finalization/deletion guard
     * @return idempotent combined lease
     */
    private static ExecutionLease combinedLease(ExecutionLease executionLease, ExecutionLease sessionGuard) {
        java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();
        return () -> {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            Throwable firstFailure = null;
            try {
                executionLease.close();
            } catch (Throwable failure) {
                firstFailure = failure;
            }
            try {
                sessionGuard.close();
            } catch (Throwable failure) {
                if (firstFailure == null) {
                    firstFailure = failure;
                }
            }
            if (firstFailure != null) {
                rethrowCloseFailure(firstFailure);
            }
        };
    }

    /**
     * Rethrows an unchecked close failure after every combined component was attempted.
     *
     * @param failure first close failure
     */
    private static void rethrowCloseFailure(Throwable failure) {
        io.reactivex.rxjava3.exceptions.Exceptions.throwIfFatal(failure);
        if (failure instanceof RuntimeException runtimeException) {
            throw runtimeException;
        }
        if (failure instanceof Error error) {
            throw error;
        }
        throw new IllegalStateException("Execution lease close failed", failure);
    }

    /**
     * Adds the lifecycle timeout and converts execution failures into one terminal event.
     *
     * @param lifecycleContext public lifecycle identity
     * @param requestContext request-local cancellation and resource ownership
     * @param events accepted execution events
     * @return public lifecycle event stream
     */
    private Flowable<Event> withLifecycle(
            RunContext lifecycleContext, AdkAgUiRunContext requestContext, Flowable<Event> events) {
        Flowable<Event> bounded = events.timeout(
                        options.runTimeout().toMillis(),
                        java.util.concurrent.TimeUnit.MILLISECONDS,
                        Flowable.error(new AdkAgUiException(
                                AdkAgUiErrorCode.EXECUTION_TIMEOUT, "Google ADK run timed out")))
                .doOnError(ignored -> requestContext.cancellation().cancel());
        Flowable<Event> lifecycle = RunLifecycle.forRun(lifecycleContext.sessionId(), lifecycleContext.runId())
                .apply(bounded, requestContext.cancellation(), requestContext.resources());
        return trackActiveRun(lifecycle, requestContext);
    }

    /**
     * Registers an in-flight run with the agent so {@link #close()} can cancel its request
     * cancellation token and close its request resource registry (Python
     * {@code ADKAgent._active_executions}). The registration is removed when the run settles.
     *
     * @param events run event stream
     * @param requestContext request-owned cancellation and resource registry
     * @return the run stream with lifecycle registration
     */
    private Flowable<Event> trackActiveRun(
            Flowable<Event> events, AdkAgUiRunContext requestContext) {
        return Flowable.defer(() -> {
            RunHandle handle = new RunHandle(
                    requestContext.cancellation(), requestContext.resources());
            activeRuns.add(handle);
            return events.doFinally(() -> activeRuns.remove(handle));
        });
    }

    /**
     * Returns a non-null official run-error message.
     *
     * @param error lifecycle failure
     * @return original message or stable fallback
     */
    private static String stableRunErrorMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? DEFAULT_RUN_ERROR_MESSAGE : message;
    }

/**
     * Creates the per-run event translator, discovering the output_schema agent names from the
     * effective agent tree so text from structured-output agents is suppressed from the chat UI
     * without any manual configuration (Python {@code _collect_output_schema_agent_names}, GitHub
     * #1390, audit finding M-01).
     *
     * <p>The translator is seeded with the accumulated state of the resolved ADK session so the
     * end-of-run {@code STATE_SNAPSHOT} carries the full session state — including keys written in
     * earlier turns or by {@code initial_state} — with this run's deltas applied on top (Python
     * builds the snapshot from {@code SessionManager.get_session_state}, audit finding F-02).
     *
     * @param context current run context
     * @param session resolved ADK session this run continues
     * @return configured event translator for this run
     */
    private EventTranslator createTranslator(AdkAgUiRunContext context, ResolvedSession session) {
        Set<String> outputSchemaAgentNames =
                com.agui.adk.translator.OutputSchemaAgentDiscovery.collect(
                        runner.rootAgent().orElse(null));
        EventTranslator translator = eventTranslatorFactory.create(
                context.sessionId(), context.runId(), outputSchemaAgentNames);
        translator.seedSessionState(sessionManager.getSessionState(session.session()));
        translator.deferFinalStateSnapshot();
        context.resources().computeIfAbsent(
                TerminalTranslatorHolder.class.getName(), TerminalTranslatorHolder::new).set(translator);
        return translator;
    }

    /**
     * Creates a stable public error event for an accepted run.
     *
     * @param code canonical machine-readable error code
     * @return a coded public terminal event
     */
    private static RunErrorEvent codedRunError(AdkAgUiErrorCode code) {
        return new RunErrorEvent(stableCodeMessage(code), code.name(), null, null);
    }

    /**
     * The stable human-readable message published with a coded error. Python always sends readable
     * text rather than the code itself, so no branch here falls back to {@code code.name()}.
     *
     * @param code canonical machine-readable error code
     * @return stable public message for that code
     */
    private static String stableCodeMessage(AdkAgUiErrorCode code) {
        return switch (code) {
            case AGENT_ERROR -> "Agent execution failed";
            case BACKGROUND_EXECUTION_ERROR -> "Background execution failed";
            case ENCODING_ERROR -> "Event encoding failed";
            case EXECUTION_ERROR -> "Execution failed";
            case EXECUTION_TIMEOUT -> "Execution timed out";
            case NO_TOOL_RESULTS -> "No tool results found in submission";
            case PENDING_TOOL_CALLS -> "Pending tool calls";
            case TOOL_RESULT_BUFFER_ERROR -> "Failed to persist tool results while waiting for the rest of the turn";
            case TOOL_RESULT_PROCESSING_ERROR -> "Failed to process tool results";
            case INVALID_RUN_INPUT -> "Invalid run input";
            case INVALID_RESUME -> "Invalid resume";
            case UNKNOWN_INTERRUPT -> "Unknown interrupt";
            case HITL_CANCELLED -> "Human-in-the-loop decision cancelled";
            case DUPLICATE_TOOL_NAME -> "Duplicate tool name";
            case UNKNOWN_TOOL_RESULT -> "Unknown tool result";
            case SESSION_FAILURE -> "Session failure";
            case CONCURRENCY_LIMIT -> "Global execution concurrency limit reached";
            case CANCELLATION -> "Run cancelled";
            case PERSISTENCE_FAILURE -> "Persistence failure";
            case UNSUPPORTED_AUTH_REQUEST -> "Unsupported auth request";
            case ADK_EXECUTION_FAILURE -> "ADK execution failure";
        };
    }

    /**
     * Returns a direct rejection for an unowned confirmation correlation.
     *
     * @return structured rejection without accepted-run lifecycle allocation
     */
    private static Flowable<Event> unknownConfirmationResult() {
        return Flowable.just(codedRunError(AdkAgUiErrorCode.UNKNOWN_TOOL_RESULT));
    }

    /**
     * Runs the accepted execution and, when the {@code emitMessagesSnapshot} option is enabled,
     * appends one {@code MESSAGES_SNAPSHOT} event at the end of the run built from the refreshed
     * session (Python {@code emit_messages_snapshot}, GitHub audit finding M-04).
     *
     * <p>Python does not emit the snapshot by default, does not prefix it before processing, and
     * constructs it at the end of the run from a session refreshed after the current turn's events
     * have been persisted. The snapshot is therefore appended after the translated execution
     * events (before {@code RUN_FINISHED}) and only when explicitly enabled.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param input official request input
     * @param session resolved ADK session
     * @param executionKey per-execution coordination identity
     * @param sessionGuard request-scoped shared session mutation guard
     * @return translated execution events followed by the optional end-of-run snapshot
     */
    private Flowable<Event> eventsWithCompleteHistorySnapshot(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            RunAgentInput input,
            ResolvedSession session,
            ExecutionKey executionKey,
            SharedSessionGuard sessionGuard) {
        Flowable<Event> events = processUnseenMessages(
                        context, requestRunConfig, input, session, executionKey, sessionGuard)
                // An accepted idempotent request can have no unseen message and therefore no ADK
                // execution/translator. Python still emits the authoritative end-of-run snapshot.
                .switchIfEmpty(Flowable.defer(() -> {
                    EventTranslator translator = createTranslator(context, session);
                    return Flowable.fromPublisher(translator.apply(Flowable.empty()));
                }));
        return events.concatWith(terminalEvents(context, session));
    }

    /**
     * Emits the authoritative Python terminal order after every translated execution has ended.
     *
     * @param context current run context
     * @param session resolved session captured at run start
     * @return state, optional messages, deferred confirmations and optional repeated state
     */
    private Flowable<Event> terminalEvents(AdkAgUiRunContext context, ResolvedSession session) {
        return Flowable.defer(() -> {
            TerminalTranslatorHolder holder = context.resources().computeIfAbsent(
                    TerminalTranslatorHolder.class.getName(), TerminalTranslatorHolder::new);
            EventTranslator translator = holder.get();
            if (translator == null) {
                translator = createTranslator(context, session);
            }
            EventTranslator terminalTranslator = translator;
            io.reactivex.rxjava3.core.Maybe<Map<String, Object>> refreshed =
                    sessionManager.getAuthoritativeSessionState(
                            context.appName(), context.userId(), context.sessionId());
            if (refreshed == null) {
                refreshed = io.reactivex.rxjava3.core.Maybe.empty();
            }
            Flowable<Event> messages = options.emitMessagesSnapshot()
                    ? messagesSnapshot(context, session) : Flowable.empty();
            Flowable<Event> tail = refreshed.defaultIfEmpty(Map.of()).flatMapPublisher(state ->
                    terminalTranslator.terminalTail(
                            terminalTranslator.finalStateSnapshot(state), messages));
            PendingCallScope scope = new PendingCallScope(
                    context.appName(), context.userId(), context.sessionId());
            Flowable<Event> interrupted = interruptStore.outstanding(scope).toList()
                    .filter(interrupts -> !interrupts.isEmpty())
                    .map(interrupts -> (Event) new RunFinishedEvent(
                            context.threadId(), context.runId(),
                            new InterruptOutcome(interrupts.stream()
                                    .map(PendingInterrupt::interrupt).toList()),
                            null, null, null))
                    .toFlowable();
            return tail.concatWith(interrupted);
        });
    }

    /** Holds the last translator for the request terminal boundary. */
    private static final class TerminalTranslatorHolder implements AutoCloseable {
        private EventTranslator translator;

        private void set(EventTranslator value) {
            translator = value;
        }

        private EventTranslator get() {
            return translator;
        }

        @Override
        public void close() {
            translator = null;
        }
    }

    /**
     * Refreshes the resolved session at the end of the run and emits one messages snapshot when
     * the history provider can present a complete history (Python {@code get_session} refresh then
     * {@code adk_events_to_messages}, audit finding M-04).
     *
     * @param context current run context
     * @param session resolved session captured at run start
     * @return zero or one {@code MessagesSnapshotEvent}
     */
    private Flowable<Event> messagesSnapshot(AdkAgUiRunContext context, ResolvedSession session) {
        return Flowable.defer(() -> sessionManager.getAuthoritativeSession(
                        context.appName(), context.userId(), session.session().id())
                .flatMapPublisher(refreshed -> messageHistoryProvider.history(refreshed)
                        .flatMapPublisher(history -> history.complete() && !history.messages().isEmpty()
                                ? Flowable.just((Event) new MessagesSnapshotEvent(history.messages()))
                                : Flowable.empty())))
                .onErrorResumeNext(error -> {
                    logger.warn("Failed to emit MESSAGES_SNAPSHOT for session '{}'",
                            context.sessionId(), error);
                    return Flowable.empty();
                });
    }

    /**
     * Filters processed request messages and preserves the imported chunking behavior.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param input official input
     * @param session resolved Google ADK session
     * @param executionKey per-execution coordination identity
     * @param sessionGuard request-scoped shared session mutation guard
     * @return translated event stream
     */
    private Flowable<Event> processUnseenMessages(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            RunAgentInput input,
            ResolvedSession session,
            ExecutionKey executionKey,
            SharedSessionGuard sessionGuard) {
        Single<Set<String>> processedIdsRead = sessionManager.getProcessedMessageIds(session.session());
        if (processedIdsRead == null) {
            processedIdsRead = Single.just(Set.of());
        }
        return processedIdsRead.flatMapPublisher(processedIds -> {
                    boolean toolSubmissionPresent = input.messages() != null
                            && !input.messages().isEmpty()
                            && input.messages().getLast().role() == com.agui.community.core.message.Role.TOOL;
                    List<Message> unseen = UnseenMessageFilter.filter(input.messages(), processedIds);
                    List<MessageChunk> chunks = messageProcessor.groupMessagesIntoChunks(unseen);
                    if (chunks.isEmpty()) {
                        return toolSubmissionPresent
                                ? Flowable.just(codedRunError(AdkAgUiErrorCode.NO_TOOL_RESULTS))
                                : Flowable.empty();
                    }
                    boolean hasToolSubmission = chunks.stream().anyMatch(MessageChunk::isToolSubmission);
                    if (!hasToolSubmission) {
                        return processAllChunks(context, requestRunConfig, chunks, session,
                                Map.of(), executionKey, sessionGuard);
                    }
                    return resolveToolCallIdToName(session, input.messages())
                            .flatMapPublisher(toolCallIdToName -> processAllChunks(
                                    context, requestRunConfig, chunks, session,
                                    toolCallIdToName, executionKey, sessionGuard));
                });
    }

    /**
     * Processes imported message chunks sequentially.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param chunks message chunks
     * @param session resolved Google ADK session
     * @param toolCallIdToName tool-call lookup
     * @param executionKey per-execution coordination identity
     * @param sessionGuard request-scoped shared session mutation guard
     * @return translated event stream
     */
    private Flowable<Event> processAllChunks(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            List<MessageChunk> chunks,
            ResolvedSession session,
            Map<String, String> toolCallIdToName,
            ExecutionKey executionKey,
            SharedSessionGuard sessionGuard) {
        return Flowable.fromIterable(chunks)
                .concatMap(chunk -> processChunk(
                        context,
                        requestRunConfig,
                        chunk,
                        session,
                        toolCallIdToName,
                        executionKey,
                        sessionGuard));
    }

    /**
     * Processes one imported message chunk.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param chunk message chunk
     * @param session resolved Google ADK session
     * @param toolCallIdToName tool-call lookup
     * @param executionKey per-execution coordination identity
     * @param sessionGuard request-scoped shared session mutation guard
     * @return translated event stream
     */
    private Flowable<Event> processChunk(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            MessageChunk chunk,
            ResolvedSession session,
            Map<String, String> toolCallIdToName,
            ExecutionKey executionKey,
            SharedSessionGuard sessionGuard) {
        return acquireExecutionLease(executionKey, context.cancellation())
                .doOnError(ignored -> context.cancellation().cancel())
                .flatMapPublisher(executionLease -> Flowable.defer(() -> {
            activeExecutionKeys.put(executionKey, Boolean.TRUE);
            PerChunkLeaseOwner lease = new PerChunkLeaseOwner(combinedLease(
                    executionLease, sessionGuard.retain()));
            // Python creates one short-lived session read cache per execution
            // (SessionManager.start_session_read_cache / stop_session_read_cache); the agent
            // lifecycle owns it here so repeated session reads within this chunk reuse the first
            // result instead of multiplying service hits (audit finding M-12).
            SessionManager.ReadCacheToken token = sessionManager.startSessionReadCache();
            Flowable<Event> events = chunk.isToolSubmission()
                    ? handleToolResultSubmission(
                            context, requestRunConfig, chunk, session, toolCallIdToName,
                            lease)
                    : startNewExecution(
                            context, requestRunConfig, chunk.userSystemMessages(), List.of(), session, lease);
            return lease.own(events)
                    .doFinally(() -> {
                        activeExecutionKeys.remove(executionKey);
                        sessionManager.stopSessionReadCache(token);
                    });
        }));
    }

    /**
     * Validates imported tool results before continuing the Google ADK run.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param chunk message chunk
     * @param session resolved Google ADK session
     * @param toolCallIdToName tool-call lookup
     * @param lease per-chunk execution lease owner
     * @return translated event stream
     */
    private Flowable<Event> handleToolResultSubmission(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            MessageChunk chunk,
            ResolvedSession session,
            Map<String, String> toolCallIdToName,
            PerChunkLeaseOwner lease) {
        PendingCallScope scope = new PendingCallScope(context.appName(), context.userId(), context.sessionId());
        if (chunk.toolMessages().isEmpty()) {
            return Flowable.just(codedRunError(AdkAgUiErrorCode.NO_TOOL_RESULTS));
        }
        return pendingCallStore.pending(scope)
                .toList()
                .flatMapPublisher(pendingCalls -> {
                    List<Message> incoming = new java.util.ArrayList<>(chunk.toolMessages());
                    incoming.addAll(chunk.userSystemMessages());
                    HitlResumePlanner.Plan plan = hitlResumePlanner.plan(
                            pendingCalls,
                            pendingCallStore.consumed(scope),
                            pendingCallStore.acceptedResultIds(scope),
                            incoming);
                    if (plan.errorCode() != null) {
                        AdkAgUiErrorCode code = "PENDING_CALLS".equals(plan.errorCode())
                                ? AdkAgUiErrorCode.PENDING_TOOL_CALLS
                                : AdkAgUiErrorCode.UNKNOWN_TOOL_RESULT;
                        return Flowable.just(codedRunError(code));
                    }
                    if (plan.frontendResults().isEmpty()) {
                        return sessionManager.processToolResults(session.session(), chunk.toolMessages(), toolCallIdToName)
                                .toList()
                                // Python wraps tool-result processing in its own
                                // TOOL_RESULT_PROCESSING_ERROR handler; classify it here so the
                                // failure is not reported as a generic persistence failure.
                                .onErrorResumeNext(error -> error instanceof TerminalRunErrorException
                                        ? Single.error(error)
                                        : Single.error(new AdkAgUiException(
                                                AdkAgUiErrorCode.TOOL_RESULT_PROCESSING_ERROR,
                                                "Failed to process tool results", error)))
                                .flatMapPublisher(validResults -> startNewExecution(
                                        context, requestRunConfig, chunk.userSystemMessages(), validResults, session,
                                        lease));
                    }
                    Set<String> arrivingResultIds = plan.frontendResults().stream()
                            .map(com.agui.community.core.message.ToolMessage::toolCallId)
                            .collect(java.util.stream.Collectors.toUnmodifiableSet());
                    com.agui.adk.hitl.PendingCallGroupKey arrivingGroup = pendingCalls.stream()
                            .filter(call -> arrivingResultIds.contains(call.key().toolCallId()))
                            .map(call -> call.key().group())
                            .findFirst()
                            .orElseThrow();
                    boolean waitingForMoreResults = pendingCalls.stream()
                            .filter(call -> call.key().group().equals(arrivingGroup))
                            .anyMatch(call -> !arrivingResultIds.contains(call.key().toolCallId())
                                    && !pendingCallStore.acceptedResultIds(scope)
                                            .contains(call.key().toolCallId()));
                    return Flowable.fromIterable(plan.frontendResults())
                            .concatMapSingle(message -> {
                                Single<PendingResultTransition> submission =
                                        toolResultProcessor.submit(scope, message);
                                return waitingForMoreResults
                                        ? submission.onErrorResumeNext(error -> Single.error(new AdkAgUiException(
                                                AdkAgUiErrorCode.TOOL_RESULT_BUFFER_ERROR,
                                                "Failed to persist tool results while waiting for the rest of the turn",
                                                error)))
                                        : submission;
                            })
                            .ofType(ResumeClaim.class)
                            .concatMap(claim -> resumeClaim(
                                    context, requestRunConfig, session, claim, plan.remainingMessages(), lease));
                })
                .onErrorResumeNext(error -> {
                    if (error instanceof TerminalRunErrorException) {
                        return Flowable.error(error);
                    }
                    if (error instanceof AdkAgUiException coded) {
                        return Flowable.just(codedRunError(coded.code()));
                    }
                    return Flowable.just(codedRunError(error instanceof IllegalArgumentException
                            ? AdkAgUiErrorCode.UNKNOWN_TOOL_RESULT
                            : AdkAgUiErrorCode.PERSISTENCE_FAILURE));
                });
    }

    /**
     * Resumes ADK with one exclusively claimed, complete frontend-call group.
     *
     * @param context current principal-scoped context
     * @param requestRunConfig immutable request configuration
     * @param session resolved ADK session used by the message transaction
     * @param claim exclusive complete pending-result claim
     * @param trailingMessages following messages carried into the same continuation
     * @param lease per-chunk execution lease owner
     * @return translated continuation events
     */
    private Flowable<Event> resumeClaim(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            ResolvedSession session,
            ResumeClaim claim,
            List<Message> trailingMessages,
            PerChunkLeaseOwner lease) {
        if (claim.originalMessages().size() != claim.results().size()) {
            return pendingCallStore.release(claim)
                    .andThen(Flowable.just(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE)));
        }
        return new ClaimReservationOwner<Boolean>(pendingCallStore.release(claim), () -> { })
                .reserve(
                        pendingCallStore.finalizationPending(claim),
                        finalizationPending -> {
                            io.reactivex.rxjava3.core.Completable release = finalizationPending
                                    ? pendingCallStore.releaseFinalization(claim)
                                    : pendingCallStore.release(claim);
                            ExecutionLease acquiredLease = lease.transfer();
                            return new ClaimReservationOwner<MessageReservation>(release, acquiredLease)
                                    .reserve(
                                            io.reactivex.rxjava3.core.Single.defer(
                                                    () -> messageReservationStore.reserve(
                                                            session,
                                                            java.util.stream.Stream.concat(
                                                                            claim.originalMessages().stream(),
                                                                            trailingMessages.stream())
                                                                    .toList(),
                                                            context.invocationId())),
                                            reservation -> finalizationPending
                                                    ? finishRecoveredClaim(claim, reservation, acquiredLease)
                                                    : resumeReservedClaim(
                                                            context,
                                                            requestRunConfig,
                                                            claim,
                                                            trailingMessages,
                                                            reservation,
                                                            acquiredLease),
                                            reservation -> rollbackReservationThen(reservation, () -> release));
                        },
                        ignored -> pendingCallStore.release(claim))
                .onErrorResumeNext(error -> error instanceof TerminalRunErrorException
                        ? Flowable.error(error)
                        : pendingCallStore.release(claim)
                                .andThen(Flowable.just(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE)))
                                .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE)));
    }

    /**
     * Builds resumed ADK content with any persisted partial-to-final LRO identifier remap.
     *
     * @param results complete frontend result group
     * @param trailingMessages messages following the result group
     * @param session resolved session carrying the remap
     * @return remapped ADK continuation content
     */
    private com.google.genai.types.Content constructResumedMessage(
            List<com.agui.adk.hitl.BufferedToolResult> results,
            List<Message> trailingMessages,
            com.google.adk.sessions.Session session) {
        Map<String, String> remap = new java.util.LinkedHashMap<>();
        Object stored = session.state().get("lro_tool_call_id_remap");
        if (stored instanceof Map<?, ?> map) {
            map.forEach((key, value) -> {
                if (key instanceof String source && value instanceof String target) {
                    remap.put(source, target);
                }
            });
        }
        List<com.google.genai.types.Part> responses = results.stream().map(result -> {
            String clientId = result.call().key().toolCallId();
            return com.google.genai.types.Part.builder().functionResponse(
                    com.google.genai.types.FunctionResponse.builder()
                            .id(remap.getOrDefault(clientId, clientId))
                            .name(result.call().event().toolCallName())
                            .response(result.result().response()).build()).build();
        }).toList();
        com.google.genai.types.Content base = messageProcessor.constructResumedMessage(results, trailingMessages);
        List<com.google.genai.types.Part> parts = new java.util.ArrayList<>(responses);
        int responseCount = results.size();
        parts.addAll(base.parts().orElse(List.of()).stream().skip(responseCount).toList());
        return com.google.genai.types.Content.builder().role("user").parts(parts).build();
    }

    /**
     * Continues a claimed frontend-result group under the Task 6 message transaction.
     *
     * @param context current principal-scoped context
     * @param requestRunConfig immutable request configuration
     * @param claim exclusively owned complete result group
     * @param trailingMessages following messages carried into the same continuation
     * @param reservation original frontend messages reserved for durable identity processing
     * @param lease execution lease owned through terminal cleanup
     * @return translated continuation events and durable finalization
     */
    private Flowable<Event> resumeReservedClaim(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            ResumeClaim claim,
            List<Message> trailingMessages,
            MessageReservation reservation,
            com.agui.adk.execution.ExecutionLease lease) {
        java.util.concurrent.atomic.AtomicBoolean finalizationPendingMarked =
                new java.util.concurrent.atomic.AtomicBoolean();
        ReservationFinalizer finalizer = new ReservationFinalizer(
                () -> sessionManager.markMessagesProcessedWithFingerprints(reservation.session().session(), reservation.messages())
                        .andThen(pendingCallStore.markFinalizationPending(claim)
                                .doOnComplete(() -> finalizationPendingMarked.set(true)))
                        .andThen(messageReservationStore.commit(reservation))
                        .andThen(pendingCallStore.complete(claim)),
                () -> rollbackReservationThen(reservation, () -> finalizationPendingMarked.get()
                        ? pendingCallStore.releaseFinalization(claim)
                        : pendingCallStore.release(claim)), lease);
        if (reservation.messages().isEmpty()) {
            return finalizer.finalizeDurably().<Event>toFlowable()
                    .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE));
        }
        Flowable<Event> execution = Flowable.defer(() -> {
            EventTranslator translator = createTranslator(context, reservation.session());
            A2uiRunEvents a2ui = runWithA2uiWiring(
                    context,
                    requestRunConfig,
                    constructResumedMessage(claim.results(), trailingMessages, reservation.session().session()),
                    Map.of());
            return translateAndPersistConfirmations(context, a2ui.adk(), translator)
                    .mergeWith(a2ui.nested());
        }).onErrorResumeNext(error -> finalizer.rollbackAfterRunnerFailure().andThen(
                        error instanceof TerminalRunErrorException
                                ? Flowable.error(error)
                                : Flowable.just(codedRunError(
                                        AdkAgUiErrorCode.ADK_EXECUTION_FAILURE))));
        return execution.concatWith(Flowable.defer(() -> finalizer.finalizeDurably()
                        .<Event>toFlowable()
                        .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE))))
                .doOnCancel(finalizer::cancel);
    }

    /**
     * Finishes a retry after the processed-message append succeeded but a later durable step failed.
     *
     * <p>The continuation has already reached its terminal ADK boundary, so this path deliberately
     * commits the fresh reservation and acknowledges the pending claim without invoking the runner.
     *
     * @param claim retained claim whose continuation completed
     * @param reservation retry reservation for its exact original tool messages
     * @param lease execution lease retained through owned finalization
     * @return completion-only stream or stable finalization failure
     */
    private Flowable<Event> finishRecoveredClaim(
            ResumeClaim claim,
            MessageReservation reservation,
            com.agui.adk.execution.ExecutionLease lease) {
        ReservationFinalizer finalizer = new ReservationFinalizer(
                () -> messageReservationStore.commit(reservation).andThen(pendingCallStore.complete(claim)),
                () -> rollbackReservationThen(
                        reservation, () -> pendingCallStore.releaseFinalization(claim)), lease);
        return finalizer.finalizeDurably().<Event>toFlowable()
                .onErrorReturnItem(codedRunError(AdkAgUiErrorCode.PERSISTENCE_FAILURE))
                .doOnCancel(finalizer::cancel);
    }

    /**
     * Rolls back a reservation while retaining branch cleanup ownership after rollback failure.
     *
     * @param reservation reservation to roll back
     * @param cleanup branch cleanup that must run regardless of rollback outcome
     * @return rollback and cleanup completion retaining the rollback failure when present
     */
    private io.reactivex.rxjava3.core.Completable rollbackReservationThen(
            MessageReservation reservation,
            java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> cleanup) {
        return io.reactivex.rxjava3.core.Completable.defer(() -> messageReservationStore.rollback(reservation))
                .onErrorResumeNext(rollbackFailure -> io.reactivex.rxjava3.core.Completable.defer(cleanup::get)
                        .andThen(io.reactivex.rxjava3.core.Completable.error(rollbackFailure)))
                .andThen(io.reactivex.rxjava3.core.Completable.defer(cleanup::get));
    }

    /**
     * Starts one Google ADK execution and applies the imported event translator.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param messageBatch messages to submit
     * @param toolResults validated tool results
     * @param session resolved Google ADK session
     * @param lease per-chunk execution lease owner
     * @return translated event stream
     */
    private Flowable<Event> startNewExecution(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            List<Message> messageBatch,
            List<ToolResult> toolResults,
            ResolvedSession session,
            PerChunkLeaseOwner lease) {
        return messageProcessor.constructMessageToSend(messageBatch, toolResults)
                .map(messageToSend -> {
                    ExecutionLease acquiredLease = lease.transfer();
                    return new ClaimReservationOwner<MessageReservation>(
                                io.reactivex.rxjava3.core.Completable.complete(), acquiredLease)
                            .reserve(
                                    io.reactivex.rxjava3.core.Single.defer(() -> messageReservationStore.reserve(
                                            session, processedMessages(messageBatch, toolResults),
                                            context.invocationId())),
                                    reservation -> executeReserved(
                                            context, requestRunConfig, messageToSend, reservation, acquiredLease),
                                    reservation -> messageReservationStore.rollback(reservation));
                })
                .orElse(Flowable.empty());
    }

    /**
     * Runs the ADK runner for one execution, applying the per-run A2UI wiring when active: the
     * agent tree is rebuilt so every {@link com.agui.adk.a2ui.A2UISubAgentTool} is a
     * per-run {@code forRun} clone bound to this run's nested-tool-call queue (and a
     * {@code generate_a2ui} tool is auto-injected on the root when the runtime forwarded
     * {@code injectA2UITool}), the injected render proxy is dropped from the frontend tools, and
     * the nested {@code TOOL_CALL_START/ARGS/END} events are merged onto the run stream.
     *
     * <p>Ordinary runs (no A2UI flag, no dev-wired A2UI tool) pass through untouched, using the
     * construction-time runner.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param message message sent to ADK
     * @param stateDelta Google ADK invocation state delta
     * @return the ADK event stream plus any nested AG-UI A2UI events to merge after translation
     */
    private A2uiRunEvents runWithA2uiWiring(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            com.google.genai.types.Content message,
            Map<String, Object> stateDelta) {
        com.agui.adk.a2ui.A2uiRunWiring.Result wiring =
                com.agui.adk.a2ui.A2uiRunWiring.prepare(
                        context, a2uiConfig, runner.rootAgent().orElse(null), requestRunConfig);
        if (wiring == null) {
            return new A2uiRunEvents(
                    Flowable.defer(() -> runner.runAsync(
                            context.userId(), context.sessionId(), message, requestRunConfig, stateDelta)),
                    Flowable.empty());
        }
        RunConfig perRunConfig = wiring.runConfig() == null ? requestRunConfig : wiring.runConfig();
        Flowable<com.google.adk.events.Event> runEvents = Flowable.defer(() -> runner.runAsync(
                        context.userId(), context.sessionId(), message, perRunConfig, stateDelta,
                        wiring.perRunAgent()))
                // The run producer owns the sole shared-queue completion signal. Individual A2UI
                // invocations may overlap and must never terminate progressive draining for peers.
                .doOnTerminate(() -> wiring.eventQueue().offer(
                        com.agui.adk.a2ui.A2uiQueueDrain.terminal()))
                .publish()
                .refCount(2);
        Flowable<com.agui.community.core.event.Event> nested =
                com.agui.adk.a2ui.A2uiQueueDrain.drain(wiring.eventQueue())
                        .takeUntil(runEvents.ignoreElements().toFlowable())
                        .concatWith(Flowable.defer(() ->
                                com.agui.adk.a2ui.A2uiQueueDrain.drainRemaining(
                                        wiring.eventQueue())));
        return new A2uiRunEvents(runEvents, nested);
    }

    /** ADK runner events plus the run's nested AG-UI events (A2UI inner tool-call stream). */
    private record A2uiRunEvents(Flowable<com.google.adk.events.Event> adk,
                                 Flowable<com.agui.community.core.event.Event> nested) {
    }

    /**
     * Executes a reservation and commits it only after the ADK stream completes.
     *
     * @param context current run context
     * @param requestRunConfig request-specific Google ADK configuration
     * @param message message sent to ADK
     * @param reservation in-flight message reservation
     * @param lease held execution coordination lease
     * @return translated event stream
     */
    private Flowable<Event> executeReserved(
            AdkAgUiRunContext context,
            RunConfig requestRunConfig,
            com.google.genai.types.Content message,
            MessageReservation reservation,
            com.agui.adk.execution.ExecutionLease lease) {
        if (reservation.messages().isEmpty()) {
            lease.close();
            return Flowable.empty();
        }
        ReservationFinalizer finalizer = new ReservationFinalizer(
                () -> sessionManager.markMessagesProcessedWithFingerprints(
                        reservation.session().session(), reservation.messages())
                        .andThen(messageReservationStore.commit(reservation)),
                () -> messageReservationStore.rollback(reservation),
                lease,
                beforeReservationCancellationClaim);
        return Flowable.defer(() -> {
                    EventTranslator translator = createTranslator(context, reservation.session());
                    A2uiRunEvents a2ui = runWithA2uiWiring(context, requestRunConfig, message, Map.of());
                    return translateAndPersistConfirmations(context, a2ui.adk(), translator)
                            .mergeWith(a2ui.nested());
                })
                .concatWith(Flowable.defer(() -> finalizer.finalizeDurably().toFlowable()))
                .onErrorResumeNext(error -> finalizer.rollbackAfterRunnerFailure().andThen(
                        Flowable.error(error instanceof TerminalRunErrorException
                                ? error
                                : new AdkAgUiException(
                                        adkResumable
                                                ? AdkAgUiErrorCode.BACKGROUND_EXECUTION_ERROR
                                                : AdkAgUiErrorCode.EXECUTION_ERROR,
                                        stableRunErrorMessage(error), error))))
                .doOnCancel(finalizer::cancel)
                .doOnError(error -> logger.error(
                        "Error during ADK run for appName '{}', sessionId '{}'",
                        context.appName(), context.sessionId(), error));
    }

    /**
     * Owns confirmation completion or release after the correlation has been atomically claimed.
     * The active terminal action remains subscribed after client disposal, so cancellation returns
     * immediately while the claim is retained until its asynchronous release settles.
     */
    private static final class ConfirmationFinalizer {
        /** Exclusive terminal ownership state for one confirmation claim. */
        private enum State { ACTIVE, COMPLETING, RELEASING, SETTLED }

        private final java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> completion;
        private final java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> release;
        private final com.agui.adk.execution.ExecutionLease lease;
        private final java.util.concurrent.atomic.AtomicReference<State> state =
                new java.util.concurrent.atomic.AtomicReference<>(State.ACTIVE);
        private final io.reactivex.rxjava3.subjects.CompletableSubject settled =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private volatile io.reactivex.rxjava3.disposables.Disposable ownedWork;

        /**
         * Creates durable confirmation ownership for an acquired execution lease.
         *
         * @param completion durable claim completion action
         * @param release durable claim release action
         * @param lease acquired execution lease
         */
        private ConfirmationFinalizer(
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> completion,
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> release,
                com.agui.adk.execution.ExecutionLease lease) {
            this.completion = Objects.requireNonNull(completion, "completion");
            this.release = Objects.requireNonNull(release, "release");
            this.lease = Objects.requireNonNull(lease, "lease");
        }

        /**
         * Starts owned claim consumption after terminal ADK success.
         *
         * @return settlement of the owned completion or release action
         */
        private io.reactivex.rxjava3.core.Completable completeDurably() {
            if (state.compareAndSet(State.ACTIVE, State.COMPLETING)) {
                ownedWork = io.reactivex.rxjava3.core.Completable.defer(completion::get)
                        .subscribe(this::complete, error -> beginRelease(error, true));
            }
            return settled;
        }

        /**
         * Releases an active claim before propagating an ADK failure.
         *
         * @return settlement of the owned release, with release failures suppressed
         */
        private io.reactivex.rxjava3.core.Completable releaseAfterFailure() {
            beginRelease(null, false);
            return settled.onErrorComplete();
        }

        /**
         * Starts non-blocking owned release when the downstream client cancels.
         * A completion already in progress owns the claim until it decides whether release is needed.
         */
        private void cancel() {
            beginRelease(null, false);
        }

        /**
         * Starts exactly one owned claim release.
         *
         * @param failure terminal failure to retain after a successful release, if any
         * @param afterCompletionFailure whether the completion owner reported failure
         */
        private void beginRelease(Throwable failure, boolean afterCompletionFailure) {
            if (!state.compareAndSet(State.ACTIVE, State.RELEASING)
                    && !(afterCompletionFailure && state.compareAndSet(State.COMPLETING, State.RELEASING))) {
                return;
            }
            ownedWork = io.reactivex.rxjava3.core.Completable.defer(release::get)
                    .retry(1)
                    .subscribe(
                            () -> settle(failure),
                            releaseFailure -> settle(failure == null ? releaseFailure : failure));
        }

        /** Completes durable claim consumption. */
        private void complete() {
            state.set(State.SETTLED);
            lease.close();
            settled.onComplete();
        }

        /**
         * Settles owned release after either success or error.
         *
         * @param failure terminal failure to report, if any
         */
        private void settle(Throwable failure) {
            state.set(State.SETTLED);
            lease.close();
            if (failure == null) {
                settled.onComplete();
            } else {
                settled.onError(failure);
            }
        }
    }

    /**
     * Releases a claimed confirmation if execution-lease acquisition cannot transfer ownership to
     * its confirmation finalizer.
     */
    private static final class ConfirmationLeaseOwner {
        /** States before and after confirmation-finalizer ownership transfer. */
        private enum State { ACQUIRING, TRANSFERRING, TRANSFERRED, RELEASING, SETTLED }

        private final java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> release;
        private final java.util.concurrent.atomic.AtomicReference<State> state =
                new java.util.concurrent.atomic.AtomicReference<>(State.ACQUIRING);
        private final java.util.concurrent.atomic.AtomicReference<com.agui.adk.execution.ExecutionLease>
                lease = new java.util.concurrent.atomic.AtomicReference<>();
        private volatile io.reactivex.rxjava3.disposables.Disposable ownedWork;

        /**
         * Creates cleanup ownership before a confirmation finalizer is available.
         *
         * @param release durable claim release action
         */
        private ConfirmationLeaseOwner(
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> release) {
            this.release = Objects.requireNonNull(release, "release");
        }

        /**
         * Acquires a lease and transfers it only after the continuation is constructed.
         *
         * @param acquisition coordinator lease acquisition
         * @param continuation continuation that transfers lease ownership
         * @return continuation events or acquisition failure
         */
        private Flowable<Event> acquire(
                io.reactivex.rxjava3.core.Single<com.agui.adk.execution.ExecutionLease> acquisition,
                java.util.function.Function<com.agui.adk.execution.ExecutionLease,
                        Flowable<Event>> continuation) {
            return acquisition.flatMapPublisher(acquired -> {
                        lease.set(acquired);
                        if (!state.compareAndSet(State.ACQUIRING, State.TRANSFERRING)) {
                            acquired.close();
                            return Flowable.empty();
                        }
                        Flowable<Event> events;
                        try {
                            events = continuation.apply(acquired);
                        } catch (Throwable error) {
                            releaseOwned();
                            return Flowable.error(error);
                        }
                        state.set(State.TRANSFERRED);
                        return events;
                    })
                    .onErrorResumeNext(error -> releaseAfterFailure().andThen(Flowable.error(error)))
                    .doOnCancel(this::cancel);
        }

        private io.reactivex.rxjava3.core.Completable releaseAfterFailure() {
            releaseOwned();
            return io.reactivex.rxjava3.core.Completable.complete();
        }

        private void cancel() {
            releaseOwned();
        }

        /** Starts retained release work while ownership has not transferred. */
        private void releaseOwned() {
            if (!state.compareAndSet(State.ACQUIRING, State.RELEASING)
                    && !state.compareAndSet(State.TRANSFERRING, State.RELEASING)) {
                return;
            }
            ownedWork = io.reactivex.rxjava3.core.Completable.defer(release::get)
                    .retry(1)
                    .subscribe(this::settle, error -> settle());
        }

        /** Settles pre-transfer cleanup and releases any concurrently acquired lease. */
        private void settle() {
            state.set(State.SETTLED);
            com.agui.adk.execution.ExecutionLease acquired = lease.getAndSet(null);
            if (acquired != null) {
                acquired.close();
            }
        }
    }

    /** Owns one freshly acquired per-chunk lease until a durable reservation accepts it. */
    static final class PerChunkLeaseOwner {
        private ExecutionLease lease;
        private boolean transferred;

        /**
         * Creates one chunk owner.
         * @param lease freshly acquired per-execution lease
         */
        PerChunkLeaseOwner(ExecutionLease lease) {
            this.lease = Objects.requireNonNull(lease, "lease");
        }

        /**
         * Transfers the lease to durable reservation ownership.
         * @return transferred lease
         */
        synchronized ExecutionLease transfer() {
            if (transferred || lease == null) {
                throw new IllegalStateException("chunk execution lease is no longer transferable");
            }
            transferred = true;
            ExecutionLease acquired = lease;
            lease = null;
            return acquired;
        }

        /**
         * Closes the lease if no reservation accepted it.
         * @param events chunk events
         * @return owned events
         */
        Flowable<Event> own(Flowable<Event> events) {
            return events.doFinally(this::closeUntransferred);
        }

        /** Closes the lease while it remains locally owned. */
        private synchronized void closeUntransferred() {
            if (lease != null) {
                lease.close();
                lease = null;
            }
        }
    }

    /**
     * Keeps one session mutation guard alive across the request root and every durable execution
     * child. The underlying guard closes only after the public stream and all transferred
     * reservation finalizers settle.
     */
    static final class SharedSessionGuard {
        private final ExecutionLease delegate;
        private int references = 1;
        private boolean closed;

        /**
         * Creates the shared owner.
         * @param delegate underlying manager mutation guard
         */
        SharedSessionGuard(ExecutionLease delegate) {
            this.delegate = Objects.requireNonNull(delegate, "delegate");
        }

        /**
         * Retains one child reference.
         * @return independently idempotent retained lease
         */
        synchronized ExecutionLease retain() {
            if (closed) {
                throw new IllegalStateException("session guard is already closed");
            }
            references++;
            java.util.concurrent.atomic.AtomicBoolean released = new java.util.concurrent.atomic.AtomicBoolean();
            return () -> {
                if (released.compareAndSet(false, true)) {
                    release();
                }
            };
        }

        /**
         * Releases the root reference when the public stream settles.
         * @param events public request events
         * @return owned event stream
         */
        Flowable<Event> own(Flowable<Event> events) {
            return events.doFinally(this::release);
        }

        /** Releases one reference and closes the delegate after the last owner settles. */
        private void release() {
            boolean closeDelegate = false;
            synchronized (this) {
                if (closed) {
                    return;
                }
                references--;
                if (references == 0) {
                    closed = true;
                    closeDelegate = true;
                }
            }
            if (closeDelegate) {
                delegate.close();
            }
        }
    }

    /**
     * Owns a claimed pending-result group through one asynchronous acquisition boundary.
     *
     * <p>The acquired value may be recovery state or a message reservation. Ownership transfers only
     * after its continuation is constructed. Before that boundary, cancellation and acquisition
     * failure retain an owned release subscription; afterward, the continuation owns its resources.
     */
    static final class ClaimReservationOwner<T> {
        /** Ownership state before or after a reservation continuation is established. */
        private enum State { ACQUIRING, TRANSFERRING, TRANSFERRED, RELEASING, SETTLED }

        private final io.reactivex.rxjava3.core.Completable release;
        private final com.agui.adk.execution.ExecutionLease lease;
        private final java.util.concurrent.atomic.AtomicReference<State> state =
                new java.util.concurrent.atomic.AtomicReference<>(State.ACQUIRING);
        private final java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
        private final java.util.concurrent.atomic.AtomicBoolean cleanupStarted = new java.util.concurrent.atomic.AtomicBoolean();
        private final Object transferLock = new Object();
        private volatile io.reactivex.rxjava3.disposables.Disposable reservationWork;
        private volatile io.reactivex.rxjava3.disposables.Disposable continuationWork;
        private volatile io.reactivex.rxjava3.disposables.Disposable cleanupWork;

        ClaimReservationOwner(
                io.reactivex.rxjava3.core.Completable release,
                com.agui.adk.execution.ExecutionLease lease) {
            this.release = Objects.requireNonNull(release, "release");
            this.lease = lease;
        }

        /**
         * Acquires a reservation while retaining claim-release ownership until the continuation is
         * constructed. Disposal of the outer stream is forwarded to the owned reservation work.
         *
         * @param reservation asynchronous reservation acquisition
         * @param continuation transaction that creates the reservation finalizer
         * @param constructionCleanup retained cleanup to run if continuation construction throws
         * @return continuation events or a stable reservation failure event
         */
        Flowable<Event> reserve(
                io.reactivex.rxjava3.core.Single<T> reservation,
                java.util.function.Function<T, Flowable<Event>> continuation,
                java.util.function.Function<T, io.reactivex.rxjava3.core.Completable> constructionCleanup) {
            return Flowable.create(emitter -> {
                emitter.setCancellable(this::cancel);
                if (state.get() != State.ACQUIRING) {
                    return;
                }
                io.reactivex.rxjava3.disposables.Disposable work = reservation.subscribe(
                        value -> continueWith(value, continuation, constructionCleanup, emitter),
                        error -> releaseClaim(emitter));
                reservationWork = work;
                if (state.get() != State.ACQUIRING) {
                    work.dispose();
                }
            }, io.reactivex.rxjava3.core.BackpressureStrategy.BUFFER);
        }

        /**
         * Transfers ownership only after a reservation continuation has been constructed.
         * @param reservation acquired message reservation
         * @param continuation reservation finalizer transaction factory
         * @param constructionCleanup retained cleanup to run if continuation construction throws
         * @param emitter downstream event emitter
         */
        private void continueWith(
                T reservation,
                java.util.function.Function<T, Flowable<Event>> continuation,
                java.util.function.Function<T, io.reactivex.rxjava3.core.Completable> constructionCleanup,
                io.reactivex.rxjava3.core.FlowableEmitter<Event> emitter) {
            if (!state.compareAndSet(State.ACQUIRING, State.TRANSFERRING)) {
                return;
            }
            Flowable<Event> next;
            try {
                next = continuation.apply(reservation);
            } catch (Throwable error) {
                cleanupAfterConstructionFailure(reservation, constructionCleanup, emitter);
                return;
            }
            synchronized (transferLock) {
                if (cancelled.get()) {
                    cleanupAfterTransferCancellation(reservation, constructionCleanup);
                    return;
                }
                state.set(State.TRANSFERRED);
                io.reactivex.rxjava3.disposables.CompositeDisposable transferredWork =
                        new io.reactivex.rxjava3.disposables.CompositeDisposable();
                continuationWork = transferredWork;
                transferredWork.add(next.subscribe(
                        emitter::onNext, emitter::onError, emitter::onComplete));
            }
        }


        /**
         * Retains reservation rollback and branch-specific claim cleanup when continuation
         * construction throws after reservation acquisition.
         *
         * @param reservation acquired message reservation
         * @param constructionCleanup cleanup that rolls back the reservation and settles its claim
         * @param emitter downstream event emitter
         */
        private void cleanupAfterConstructionFailure(
                T reservation,
                java.util.function.Function<T, io.reactivex.rxjava3.core.Completable> constructionCleanup,
                io.reactivex.rxjava3.core.FlowableEmitter<Event> emitter) {
            if (!state.compareAndSet(State.TRANSFERRING, State.RELEASING)) {
                return;
            }
            cleanupWork = io.reactivex.rxjava3.core.Completable.defer(() -> constructionCleanup.apply(reservation))
                    .subscribe(
                            () -> releaseSettled(emitter, AdkAgUiErrorCode.PERSISTENCE_FAILURE),
                            ignored -> releaseSettled(emitter, AdkAgUiErrorCode.PERSISTENCE_FAILURE));
        }

        /**
         * Retains branch cleanup when cancellation wins before continuation subscription.
         * @param reservation acquired value whose continuation was not subscribed
         * @param constructionCleanup retained branch cleanup
         */
        private void cleanupAfterTransferCancellation(
                T reservation,
                java.util.function.Function<T, io.reactivex.rxjava3.core.Completable> constructionCleanup) {
            if (!state.compareAndSet(State.TRANSFERRING, State.RELEASING)) {
                return;
            }
            cleanupWork = io.reactivex.rxjava3.core.Completable.defer(
                            () -> constructionCleanup.apply(reservation))
                    .subscribe(
                            () -> releaseSettled(null, AdkAgUiErrorCode.PERSISTENCE_FAILURE),
                            ignored -> releaseSettled(null, AdkAgUiErrorCode.PERSISTENCE_FAILURE));
        }

        /** Cancels acquisition or forwards cancellation to the reservation finalizer after transfer. */
        private void cancel() {
            cancelled.set(true);
            synchronized (transferLock) {
                if (state.compareAndSet(State.ACQUIRING, State.RELEASING)) {
                    io.reactivex.rxjava3.disposables.Disposable work = reservationWork;
                    if (work != null) {
                        work.dispose();
                    }
                    releaseClaim(null);
                    return;
                }
                if (state.get() == State.TRANSFERRED) {
                    io.reactivex.rxjava3.disposables.Disposable work = continuationWork;
                    if (work != null) {
                        work.dispose();
                    }
                }
            }
        }

        /**
         * Retains release ownership through asynchronous claim cleanup.
         * @param emitter downstream error event target, or null after disposal
         */
        private void releaseClaim(io.reactivex.rxjava3.core.FlowableEmitter<Event> emitter) {
            if (state.compareAndSet(State.ACQUIRING, State.RELEASING)) {
                // The reservation failed before cancellation initiated cleanup.
            } else if (state.get() != State.RELEASING) {
                return;
            }
            if (!cleanupStarted.compareAndSet(false, true)) {
                return;
            }
            cleanupWork = io.reactivex.rxjava3.core.Completable.defer(() -> release)
                    .subscribe(
                            () -> releaseSettled(emitter, AdkAgUiErrorCode.PERSISTENCE_FAILURE),
                            ignored -> releaseSettled(emitter, AdkAgUiErrorCode.PERSISTENCE_FAILURE));
        }

        /**
         * Completes a failed acquisition after its owned cleanup reaches a terminal state.
         * @param emitter downstream error event target, or null after disposal
         * @param errorCode stable terminal classification for the failed operation
         */
        private void releaseSettled(
                io.reactivex.rxjava3.core.FlowableEmitter<Event> emitter, AdkAgUiErrorCode errorCode) {
            state.set(State.SETTLED);
            lease.close();
            if (cancelled.get()) {
                return;
            }
            emitter.onNext(codedRunError(errorCode));
            emitter.onComplete();
        }
    }

    /**
     * Owns a reservation's terminal action when downstream disposal races durable finalization.
     * The owned subscription is deliberately retained until commit or rollback settles, so a
     * disposed client cannot turn a completed durable append into an in-process rollback.
     */
    static final class ReservationFinalizer {
        /** Terminal ownership state for one reservation. */
        private enum State { ACTIVE, FINALIZING, ROLLING_BACK, SETTLED }

        private final java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> durableFinalization;
        private final java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> cleanup;
        private final com.agui.adk.execution.ExecutionLease lease;
        private final Runnable beforeCancellationClaim;
        private final java.util.concurrent.atomic.AtomicReference<State> state =
                new java.util.concurrent.atomic.AtomicReference<>(State.ACTIVE);
        private final io.reactivex.rxjava3.subjects.CompletableSubject settled =
                io.reactivex.rxjava3.subjects.CompletableSubject.create();
        private volatile io.reactivex.rxjava3.disposables.Disposable ownedWork;

        /**
         * Creates an owned terminal lifecycle.
         * @param durableFinalization ordered durable success transaction
         * @param cleanup ordered compensating transaction
         * @param lease execution lease held until terminal settlement
         */
        ReservationFinalizer(
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> durableFinalization,
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> cleanup,
                com.agui.adk.execution.ExecutionLease lease) {
            this(durableFinalization, cleanup, lease, () -> { });
        }

        /**
         * Creates a terminal lifecycle with a deterministic cancellation interleaving hook.
         * @param durableFinalization ordered durable success transaction
         * @param cleanup ordered compensating transaction
         * @param lease execution lease held until terminal settlement
         * @param beforeCancellationClaim test hook before cancellation claims active ownership
         */
        ReservationFinalizer(
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> durableFinalization,
                java.util.function.Supplier<io.reactivex.rxjava3.core.Completable> cleanup,
                com.agui.adk.execution.ExecutionLease lease,
                Runnable beforeCancellationClaim) {
            this.durableFinalization = Objects.requireNonNull(durableFinalization, "durableFinalization");
            this.cleanup = Objects.requireNonNull(cleanup, "cleanup");
            this.lease = lease;
            this.beforeCancellationClaim = beforeCancellationClaim;
        }

        /**
         * Starts durable finalization, retaining ownership beyond downstream disposal.
         * @return completion when terminal ownership settles
         */
        io.reactivex.rxjava3.core.Completable finalizeDurably() {
            if (state.compareAndSet(State.ACTIVE, State.FINALIZING)) {
                ownedWork = io.reactivex.rxjava3.core.Completable.defer(durableFinalization::get)
                        .subscribe(this::complete, this::failFinalization);
            }
            return settled;
        }

        /**
         * Owns compensation before propagating runner failure.
         * @return completion when compensation settles
         */
        io.reactivex.rxjava3.core.Completable rollbackAfterRunnerFailure() {
            beginRollbackFromActive(null);
            return settled.onErrorComplete();
        }

        /**
         * Starts compensation only when durable finalization does not already own settlement.
         * The pre-read on {@code state} only gates the deterministic test interleaving seam
         * ({@code beforeCancellationClaim}); it is an optimization, not the ownership guard.
         * Real ownership is granted exclusively by the CAS inside {@link #beginRollbackFromActive},
         * so a cancel that observes ACTIVE but loses the claim to durable finalization never rolls back.
         */
        void cancel() {
            if (state.get() == State.ACTIVE) {
                beforeCancellationClaim.run();
                beginRollbackFromActive(null);
            }
        }

        /**
         * Owns compensation before reporting a durable finalization failure.
         * @param error failed durable operation
         */
        private void failFinalization(Throwable error) {
            if (state.compareAndSet(State.FINALIZING, State.ROLLING_BACK)) {
                startRollback(error);
            }
        }

        /**
         * Claims compensation only before durable finalization owns settlement.
         * @param failure terminal failure to report after cleanup, if any
         */
        private void beginRollbackFromActive(Throwable failure) {
            if (state.compareAndSet(State.ACTIVE, State.ROLLING_BACK)) {
                startRollback(failure);
            }
        }

        /**
         * Starts the compensating transaction after its state transition succeeds.
         * @param failure terminal failure to report after cleanup, if any
         */
        private void startRollback(Throwable failure) {
            ownedWork = io.reactivex.rxjava3.core.Completable.defer(cleanup::get).subscribe(
                    () -> settle(failure),
                    cleanupFailure -> settle(failure == null ? cleanupFailure : failure));
        }

        /** Marks owned work terminal and releases a cancelled execution lease. */
        private void complete() {
            state.set(State.SETTLED);
            closeLeaseThen(settled::onComplete);
        }

        /**
         * Terminates retained ownership after compensation reaches a durable endpoint.
         * @param failure terminal failure to report after cleanup, if any
         */
        private void settle(Throwable failure) {
            state.set(State.SETTLED);
            closeLeaseThen(() -> {
                if (failure == null) {
                    settled.onComplete();
                } else {
                    settled.onError(failure);
                }
            });
        }

        /**
         * Closes admission before settlement without allowing a close failure to strand observers.
         * @param signal terminal settlement signal
         */
        private void closeLeaseThen(Runnable signal) {
            Throwable closeFailure = null;
            try {
                lease.close();
            } catch (Throwable failure) {
                io.reactivex.rxjava3.exceptions.Exceptions.throwIfFatal(failure);
                closeFailure = failure;
            }
            signal.run();
            if (closeFailure != null) {
                io.reactivex.rxjava3.plugins.RxJavaPlugins.onError(closeFailure);
            }
        }
    }

    /**
     * Selects only messages actually accepted as input for a run.
     *
     * @param messageBatch non-tool chunk messages
     * @param toolResults validated tool-result messages
     * @return messages eligible for durable processed-ID marking
     */
    private static List<Message> processedMessages(
            List<Message> messageBatch, List<ToolResult> toolResults) {
        List<Message> messages = new java.util.ArrayList<>();
        toolResults.stream().map(ToolResult::message).forEach(messages::add);
        messageBatch.stream().filter(message -> message.role() == com.agui.community.core.message.Role.USER)
                .forEach(messages::add);
        return messages;
    }

    /**
     * Resolves tool names from authoritative ADK history plus the current request.
     * Duplicate IDs are deterministic: later calls win, so request messages override history.
     *
     * @param session resolved authoritative session
     * @param messages official input messages
     * @return tool-call names keyed by non-blank ID
     */
    private Single<Map<String, String>> resolveToolCallIdToName(
            ResolvedSession session, List<Message> messages) {
        io.reactivex.rxjava3.core.Maybe<com.google.adk.sessions.Session> authoritative =
                sessionManager.getAuthoritativeSession(
                        session.session().appName(), session.session().userId(), session.session().id());
        if (authoritative == null) {
            authoritative = io.reactivex.rxjava3.core.Maybe.just(session.session());
        }
        return authoritative.defaultIfEmpty(session.session())
                .map(authoritativeSession -> {
                    Map<String, String> names = new java.util.LinkedHashMap<>();
                    authoritativeSession.events().forEach(event -> event.functionCalls().forEach(call ->
                            call.id().filter(id -> !id.isBlank()).ifPresent(id ->
                                    call.name().filter(name -> !name.isBlank()).ifPresent(name -> names.put(id, name)))));
                    collectRequestToolCallNames(messages, names);
                    return Map.copyOf(names);
                });
    }

    /**
     * Adds request call names to a last-write-wins lookup.
     *
     * @param messages official request messages
     * @param names mutable lookup seeded from authoritative history
     */
    private static void collectRequestToolCallNames(List<Message> messages, Map<String, String> names) {
        messages.stream()
                .filter(AssistantMessage.class::isInstance)
                .map(AssistantMessage.class::cast)
                .map(AssistantMessage::toolCalls)
                .filter(Objects::nonNull)
                .flatMap(List::stream)
                .forEach(toolCall -> {
                    String id = toolCall.id();
                    String name = toolCall.function().name();
                    if (id != null && !id.isBlank() && name != null && !name.isBlank()) {
                        names.put(id, name);
                    }
                });
    }

    /**
     * Builder for the baseline Google ADK agent.
     */
    public static final class Builder {
        private AdkRunnerClient runner;
        private SessionManager sessionManager;
        private RunConfig runConfig = RunConfig.builder().build();
        private String staticUserId;
        private Function<RunAgentInput, String> userIdExtractor;
        private String staticAppName;
        private Function<RunAgentInput, String> appNameExtractor;
        private AdkAgUiOptions options = AdkAgUiOptions.defaults();
        private ExecutionCoordinator executionCoordinator = new InProcessExecutionCoordinator();
        private MessageReservationStore messageReservationStore;
        private PendingCallStore pendingCallStore;
        private InterruptStore interruptStore;
        private CanonicalEventEncoder eventEncoder;
        private Set<String> configuredBackendToolNames;
        private ConfirmationRequestStore confirmationRequestStore;
        private AdkAuthRequestAdapter authRequestAdapter;
        private MessageHistoryProvider messageHistoryProvider;
        private Runnable beforeReservationCancellationClaim = () -> { };
        private com.agui.adk.translator.EventTranslatorFactoryFn eventTranslatorFactory =
                (threadId, runId, outputSchemaAgentNames) -> EventTranslatorFactory.INSTANCE
                        .create(threadId, runId, List.of(), outputSchemaAgentNames);
        private java.util.function.Function<
                com.agui.adk.context.AdkAgUiRunContext,
                java.util.Map<String, Object>> metadataEnricher = context -> java.util.Map.of();
        private SessionCleanupPolicy sessionCleanupPolicy;
        private Map<String, Object> a2uiConfig;
        private boolean adkResumable;
        private Map<String, Object> declaredCapabilities;
        private boolean capabilitiesDeclared;

        /**
         * Sets the deterministic runner seam.
         *
         * @param value runner client
         * @return this builder
         */
        public Builder runner(AdkRunnerClient value) {
            runner = value;
            return this;
        }

        /**
         * Sets the baseline session manager.
         *
         * @param value session manager
         * @return this builder
         */
        public Builder sessionManager(SessionManager value) {
            sessionManager = value;
            return this;
        }

        /**
         * Sets the base Google ADK run configuration.
         *
         * @param value run configuration
         * @return this builder
         */
        public Builder baseRunConfig(RunConfig value) {
            runConfig = value;
            return this;
        }

        /**
         * Sets a static user identifier used for every run (Python {@code user_id}).
         *
         * @param value static user identifier, or null for extractor/default resolution
         * @return this builder
         */
        public Builder userId(String value) {
            staticUserId = value;
            return this;
        }

        /**
         * Sets the per-request user-ID extraction seam (Python {@code user_id_extractor}).
         *
         * @param value extractor, or null for static/default resolution
         * @return this builder
         */
        public Builder userIdExtractor(Function<RunAgentInput, String> value) {
            userIdExtractor = value;
            return this;
        }

        /**
         * Sets a static Google ADK application name used for every run (Python {@code app_name}).
         *
         * @param value static application name, or null for extractor/default resolution
         * @return this builder
         */
        public Builder appName(String value) {
            staticAppName = value;
            return this;
        }

        /**
         * Sets the per-request application-name extraction seam (Python {@code app_name_extractor}).
         *
         * @param value extractor, or null for static/default resolution
         * @return this builder
         */
        public Builder appNameExtractor(Function<RunAgentInput, String> value) {
            appNameExtractor = value;
            return this;
        }

        /**
         * Sets framework-neutral bridge options.
         *
         * @param value bridge options
         * @return this builder
         */
        public Builder options(AdkAgUiOptions value) {
            options = Objects.requireNonNull(value, "options");
            return this;
        }

        /**
         * Sets whether ADK owns native pause/resume behavior for long-running operations.
         *
         * @param value true when the backing App enables resumability
         * @return this builder
         */
        Builder adkResumable(boolean value) {
            adkResumable = value;
            return this;
        }

        /**
         * Sets application-declared AG-UI capabilities returned by the public discovery endpoint.
         * A {@code null} value explicitly declares that no capabilities are configured.
         *
         * @param value JSON-serializable capability map, or {@code null}
         * @return this builder
         */
        public Builder capabilities(Map<String, Object> value) {
            declaredCapabilities = AdkAgUiCapabilities.snapshot(value);
            capabilitiesDeclared = true;
            return this;
        }

        /**
         * Sets the execution coordinator for same-thread runs.
         *
         * @param coordinator execution coordinator
         * @return this builder
         */
        public Builder executionCoordinator(ExecutionCoordinator coordinator) {
            executionCoordinator = Objects.requireNonNull(coordinator, "executionCoordinator");
            return this;
        }

        /**
         * Sets static backend names from the root-agent composition boundary.
         *
         * <p>Configured dynamic tool sources must publish their complete visible name set here;
         * opaque dynamic discovery is not attempted while preparing a request.
         *
         * @param names authoritative configured backend tool names
         * @return this builder
         */
        public Builder configuredBackendToolNames(java.util.Collection<String> names) {
            configuredBackendToolNames = Set.copyOf(Objects.requireNonNull(names, "names"));
            return this;
        }

        /**
         * Sets the per-run event translator factory.
         *
         * @param factory translator factory
         * @return this builder
         */
        Builder eventTranslatorFactory(
                com.agui.adk.translator.EventTranslatorFactoryFn factory) {
            eventTranslatorFactory = Objects.requireNonNull(factory, "eventTranslatorFactory");
            return this;
        }

        /**
         * Sets a deterministic hook immediately before cancellation claims a fresh reservation.
         *
         * @param hook cancellation interleaving hook
         * @return this builder
         */
        Builder beforeReservationCancellationClaim(Runnable hook) {
            beforeReservationCancellationClaim = Objects.requireNonNull(hook, "beforeReservationCancellationClaim");
            return this;
        }

        /**
         * Sets the transactional processed-message reservation store.
         *
         * @param store reservation store
         * @return this builder
         */
        public Builder messageReservationStore(MessageReservationStore store) {
            messageReservationStore = Objects.requireNonNull(store, "messageReservationStore");
            return this;
        }

        /**
         * Sets the persistence boundary for frontend tool calls.
         *
         * @param store pending-call store
         * @return this builder
         */
        public Builder pendingCallStore(PendingCallStore store) {
            pendingCallStore = Objects.requireNonNull(store, "pendingCallStore");
            return this;
        }

        /**
         * Sets the durable official interrupt admission boundary.
         * @param store scoped atomic interrupt store
         * @return this builder
         */
        public Builder interruptStore(InterruptStore store) {
            interruptStore = Objects.requireNonNull(store, "interruptStore");
            return this;
        }

        /**
         * Sets the canonical JSON encoder used before frontend-call persistence.
         *
         * @param encoder official-event encoder
         * @return this builder
         */
        public Builder eventEncoder(CanonicalEventEncoder encoder) {
            eventEncoder = Objects.requireNonNull(encoder, "eventEncoder");
            return this;
        }

        /**
         * Sets native ADK confirmation correlation storage.
         *
         * @param store confirmation persistence boundary
         * @return this builder
         */
        public Builder confirmationRequestStore(ConfirmationRequestStore store) {
            confirmationRequestStore = Objects.requireNonNull(store, "confirmationRequestStore");
            return this;
        }

        /**
         * Sets the optional request-local auth adapter.
         *
         * @param adapter explicit auth boundary
         * @return this builder
         */
        public Builder authRequestAdapter(AdkAuthRequestAdapter adapter) {
            authRequestAdapter = Objects.requireNonNull(adapter, "adapter");
            return this;
        }

        /**
         * Sets the canonical message-history provider used for optional official snapshots.
         *
         * @param provider explicit history completeness boundary
         * @return this builder
         */
        public Builder messageHistoryProvider(MessageHistoryProvider provider) {
            messageHistoryProvider = Objects.requireNonNull(provider, "provider");
            return this;
        }

        /**
         * Sets a framework-neutral per-run metadata enricher.
         *
         * <p>Supplied by the composition boundary (for example the application's infrastructure
         * module) to attach additional request-scoped values to each run's metadata. The
         * enricher receives the resolved {@code AdkAgUiRunContext} and returns key-value
         * entries to merge into the request metadata; it may not override the reserved bridge
         * context key.
         *
         * @param value per-run metadata enricher
         * @return this builder
         */
        public Builder metadataEnricher(
                java.util.function.Function<
                        com.agui.adk.context.AdkAgUiRunContext,
                        java.util.Map<String, Object>> value) {
            metadataEnricher = Objects.requireNonNull(value, "metadataEnricher");
            return this;
        }

        /**
         * Opts the run lifecycle into automatic expired-session cleanup (Python auto-vectorizes
         * cleanup on the run lifecycle). When set, each accepted run terminal invokes
         * {@link SessionManager#cleanupExpiredSessions} for the resolved app/user as an owned
         * side effect, matching Python's run-lifecycle cleanup scheduling.
         *
         * @param policy explicit expiry, interval and HITL-preservation policy; {@code null} disables
         * @return this builder
         * @see SessionManager#cleanupExpiredSessions(String, String, SessionCleanupPolicy, java.time.Instant)
         */
        public Builder sessionCleanupPolicy(SessionCleanupPolicy policy) {
            sessionCleanupPolicy = policy;
            return this;
        }

        /**
         * Sets the backend A2UI config ({@code inject_a2ui_tool} / {@code catalog} /
         * {@code default_catalog_id} / {@code guidelines} / {@code recovery} knobs, mirroring the
         * Python {@code ADKAgent(a2ui=...)} option). Per-run auto-injection is additionally driven
         * by the forwarded {@code injectA2UITool} run flag, which wins over this config.
         *
         * @param value A2UI backend config (may be null for no auto-injection)
         * @return this builder
         */
        public Builder a2uiConfig(Map<String, Object> value) {
            a2uiConfig = value;
            return this;
        }

        /**
         * Builds the official AG-UI agent.
         *
         * @return configured agent
         */
        public GoogleAdkAgent build() {
            if ((staticUserId == null || staticUserId.isBlank()) && userIdExtractor == null) {
                throw new IllegalStateException("userIdExtractor must be configured");
            }
            if (staticUserId != null && !staticUserId.isBlank() && userIdExtractor != null) {
                throw new IllegalStateException("Cannot specify both userId and userIdExtractor");
            }
            if (staticAppName != null && !staticAppName.isBlank() && appNameExtractor != null) {
                throw new IllegalStateException("Cannot specify both appName and appNameExtractor");
            }
            if (configuredBackendToolNames == null) {
                throw new IllegalStateException("configuredBackendToolNames must be configured");
            }
            return new GoogleAdkAgent(this);
        }
    }
}
