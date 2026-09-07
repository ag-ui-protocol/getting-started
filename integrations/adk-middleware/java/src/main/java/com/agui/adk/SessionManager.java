package com.agui.adk;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.adk.context.AdkAgUiRunContext;
import com.agui.adk.execution.ExecutionLease;
import com.agui.adk.history.ToolResultExtractor;
import com.agui.adk.message.MessageFingerprint;
import com.agui.adk.message.MessageReservationStore;
import com.agui.adk.message.SessionMessageReservationStore;
import com.agui.adk.processor.ToolResult;
import com.agui.adk.session.InMemoryThreadSessionMappingStore;
import com.agui.adk.session.RequestStateSessionService;
import com.agui.adk.session.ResolvedSession;
import com.agui.adk.session.SessionCleanupPolicy;
import com.agui.adk.session.SessionCleanupService;
import com.agui.adk.session.SessionMapping;
import com.agui.adk.session.SessionMappingKey;
import com.agui.adk.session.SessionStateKeys;
import com.agui.adk.session.ThreadSessionMappingStore;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.ToolMessage;
import com.google.adk.events.Event;
import com.google.adk.events.EventActions;
import com.google.adk.memory.BaseMemoryService;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.ListSessionsResponse;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.exceptions.Exceptions;
import io.reactivex.rxjava3.plugins.RxJavaPlugins;
import io.reactivex.rxjava3.schedulers.Schedulers;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import java.util.function.BinaryOperator;
import java.util.stream.Collectors;

/**
 * Imported Google ADK session-state coordinator.
 */
public final class SessionManager {

    private static final Logger logger = LoggerFactory.getLogger(SessionManager.class);
    private static final String PROCESSED_MESSAGE_IDS_KEY = SessionMessageReservationStore.PROCESSED_MESSAGE_IDS_KEY;
    private static final String FINGERPRINTS_STATE_KEY = SessionMessageReservationStore.FINGERPRINTS_STATE_KEY;
    private static final String PENDING_TOOL_CALL_IDS_KEY = "pendingToolCallIds";
    private static final ObjectMapper JSON = new ObjectMapper();
    private final BaseSessionService sessionService;
    private final BaseMemoryService memoryService;
    private final ThreadSessionMappingStore mappingStore;
    private final AdkAgUiOptions options;
    // Per-session monitor used to serialize read-modify-write of session state
    // (processedMessageIds, pendingToolCallIds) for the SAME session within this JVM.
    // Distinct sessions still run in parallel. Entries removed on deleteSession.
    private final ConcurrentMap<SessionIdentity, Object> sessionWriteLocks = new ConcurrentHashMap<>();
    // Per-JVM durable-write snapshots supplement potentially immutable/stale ADK Session views.
    private final ConcurrentMap<SessionIdentity, ProcessedMessageState> processedMessageStates = new ConcurrentHashMap<>();
    // Serializes a confirmed deletion with every accepted execution finalizer for the same ADK
    // session identity. A retired entry remains mapped until its active and queued participants
    // settle, then conditionally removes only its own identity-safe mapping.
    private final ConcurrentMap<SessionIdentity, MutationGuardEntry> sessionMutationGuards = new ConcurrentHashMap<>();
    // user_id -> appName:sessionId keys, mirroring Python SessionManager._user_sessions.
    private final ConcurrentMap<String, java.util.Set<String>> userSessionKeys = new ConcurrentHashMap<>();
    // sessionId -> instant the session was first preserved as an expired HITL session
    // (Python SessionManager._hitl_preserved_since).
    private final ConcurrentMap<String, Instant> hitlPreservedSince = new ConcurrentHashMap<>();
    // Max concurrent sessions per user; null = unlimited (Python max_sessions_per_user).
    private final Integer maxSessionsPerUser;
    private final Set<MessageReservationStore> messageReservationStores =
            Collections.synchronizedSet(Collections.newSetFromMap(new IdentityHashMap<>()));
    private final ConcurrentMap<CleanupKey, Completable> inFlightCleanup = new ConcurrentHashMap<>();
    // Backend session keys already archived without deletion (archive-only mode): a later
    // cleanup cycle must not re-archive a session the manager already forgot and untracked
    // (Python SessionManager._delete_session -> _untrack_session semantics).
    private final java.util.Set<String> archivedSessionKeys = ConcurrentHashMap.newKeySet();
    // (appName, userId, threadId) triples whose persisted pending tool-call markers were
    // already verified on this instance (Python ADKAgent._sessions_verified_locally); each
    // triple is verified at most once per process lifetime so a later crash-restart marker
    // written after the first access is left alone.
    private final java.util.Set<PendingVerificationKey> verifiedPendingCallThreads =
            ConcurrentHashMap.newKeySet();
    // Process-wide default manager (Python SessionManager._default), lazily constructed by
    // getDefault() and cleared by resetDefault().
    private static volatile SessionManager defaultManager;
    // Per-execution session read cache, the ContextVar-equivalent of Python's
    // _SESSION_READ_CACHE: one map per opening thread, keyed by (appName, userId, sessionId),
    // for the duration of one execution context, started/stopped/disabled explicitly. The
    // registry is keyed by thread instead of being a raw ThreadLocal so the lifecycle can close
    // the cache even when the execution settles on a different thread (the durable finalizer
    // completes on a scheduler thread, which must not leak the opening thread's cache).
    private final ConcurrentMap<Long, Map<SessionCacheKey, Session>> sessionReadCaches =
            new ConcurrentHashMap<>();
    // Lazy background cleanup scheduler (Python async _cleanup_loop): created on the first
    // startCleanupTask()/getDefault() and shut down by stopCleanupTask().
    private final AtomicReference<java.util.concurrent.ScheduledExecutorService> cleanupScheduler =
            new AtomicReference<>();
    private final AtomicReference<java.util.concurrent.ScheduledFuture<?>> cleanupTask =
            new AtomicReference<>();
    private volatile SessionCleanupPolicy cleanupPolicy = defaultCleanupPolicy();
    // Python fixes cleanup settings at manager construction. Java permits pre-start configuration,
    // then freezes the policy permanently on the first cleanup start.
    private boolean cleanupPolicyFrozen;

    /**
     * A per-execution session read-cache key.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     */
    private record SessionCacheKey(String appName, String userId, String sessionId) {
    }

    /**
     * Session paired with imported processed message IDs.
     *
     * @param session Google ADK session
     * @param processedIds processed message IDs
     */
    record SessionWithProcessedIds(Session session, Set<String> processedIds) {
    }

    /**
     * Mutable reduction state for imported tool result validation.
     *
     * @param validResults accepted tool results
     * @param processedIds processed tool-call IDs
     */
    private record ToolProcessingAccumulator(
            List<ToolResult> validResults, Set<String> processedIds) {
    }

    /**
     * Process-local identity of an explicit cleanup invocation.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     */
    private record CleanupKey(String appName, String userId) {
    }

    /**
     * Per-instance identity of a verified pending-tool-call triple.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param threadId AG-UI thread identity
     */
    private record PendingVerificationKey(String appName, String userId, String threadId) {
    }

    /**
     * Creates the session manager.
     *
     * @param sessionService Google ADK session service
     * @param memoryService Google ADK memory service
     */
    public SessionManager(BaseSessionService sessionService, BaseMemoryService memoryService) {
        this(sessionService, memoryService, new InMemoryThreadSessionMappingStore(), AdkAgUiOptions.defaults());
    }

    /**
     * Creates a session manager with explicit generated-ID mapping behavior.
     *
     * @param sessionService Google ADK session service
     * @param memoryService Google ADK memory service
     * @param mappingStore thread-to-session mapping store
     * @param options typed bridge options controlling compatible direct-ID behavior
     */
    public SessionManager(
            BaseSessionService sessionService,
            BaseMemoryService memoryService,
            ThreadSessionMappingStore mappingStore,
            AdkAgUiOptions options) {
        this.sessionService = Objects.requireNonNull(sessionService, "sessionService");
        this.memoryService = Objects.requireNonNull(memoryService, "memoryService");
        this.mappingStore = Objects.requireNonNull(mappingStore, "mappingStore");
        this.options = Objects.requireNonNull(options, "options");
        this.maxSessionsPerUser = options.maxSessionsPerUser();
    }

    /**
     * Resolves the ADK session for a validated AG-UI request context.
     *
     * @param context immutable AG-UI request context
     * @return resolved ADK session and stable mapping
     */
    public Single<ResolvedSession> resolveSession(AdkAgUiRunContext context) {
        Objects.requireNonNull(context, "context");
        SessionMappingKey key = new SessionMappingKey(
                context.appName(), context.userId(), context.threadId());
        if (options.useThreadIdAsSessionId()) {
            SessionMapping mapping = new SessionMapping(key, context.threadId());
            return getOrCreateMappedSession(mapping)
                    .map(session -> new ResolvedSession(session, mapping));
        }
        return resolveGeneratedSession(key);
    }

    /**
     * Gets or creates a session outside a full run, mirroring Python
     * {@code SessionManager.get_or_create_session}: enforces the per-user cap, seeds new
     * sessions with the caller-supplied initial state plus the protected thread/app/user
     * markers, optionally skips the negative thread-marker scan when the caller already
     * confirmed no session exists, tracks the session, and lazily starts the background
     * cleanup loop (M-29/M-10).
     *
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @param threadId AG-UI thread identity
     * @param initialState optional initial state for a newly created session
     * @param skipFind whether a negative thread-marker scan is already known
     * @return resolved session and durable mapping
     */
    public Single<ResolvedSession> getOrCreateSession(
            String appName, String userId, String threadId,
            Map<String, Object> initialState, boolean skipFind) {
        Objects.requireNonNull(appName, "appName");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(threadId, "threadId");
        SessionMappingKey key = new SessionMappingKey(appName, userId, threadId);
        Single<ResolvedSession> resolution;
        if (options.useThreadIdAsSessionId()) {
            SessionMapping mapping = new SessionMapping(key, threadId);
            resolution = getOrCreateByThreadId(mapping, initialState)
                    .map(session -> new ResolvedSession(session, mapping));
        } else {
            resolution = getOrCreateByScan(key, initialState, skipFind)
                    .map(session -> new ResolvedSession(session, new SessionMapping(key, session.id())));
        }
        // Python checks the per-user cap before resolving (get_or_create_session).
        return enforcePerUserLimit(userId)
                .andThen(resolution)
                .doOnSuccess(resolved -> trackSession(resolved.session()))
                // Python starts the cleanup loop on every get/create, for any manager (M-10).
                .doOnSuccess(ignored -> startCleanupTask());
    }

    /**
     * Reads a session directly by its backend session identifier, mirroring Python
     * {@code SessionManager.get_session} (M-29): the per-execution read cache is consulted
     * first when one is active, then the backend service.
     *
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @param sessionId backend session identifier
     * @return the matching session, or an empty signal
     */
    public Maybe<Session> getSession(String appName, String userId, String sessionId) {
        Objects.requireNonNull(appName, "appName");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(sessionId, "sessionId");
        return readSessionCached(appName, userId, sessionId);
    }

    /**
     * Reads a session directly from the backing service, bypassing the per-execution read cache so
     * callers observe events and state persisted during the just-completed run.
     *
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @param sessionId backend session identifier
     * @return the freshly read session, or an empty signal when the session is absent
     */
    public Maybe<Session> getAuthoritativeSession(String appName, String userId, String sessionId) {
        Objects.requireNonNull(appName, "appName");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(sessionId, "sessionId");
        return sessionService.getSession(appName, userId, sessionId, Optional.empty());
    }

    /**
     * Reads authoritative session state directly from the backing service, bypassing the
     * per-execution read cache so callers observe mutations made during the just-completed run.
     *
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @param sessionId backend session identifier
     * @return freshly read immutable state, or an empty signal when the session is absent
     */
    public Maybe<Map<String, Object>> getAuthoritativeSessionState(
            String appName, String userId, String sessionId) {
        return getAuthoritativeSession(appName, userId, sessionId).map(this::getSessionState);
    }

    /**
     * Gets or creates a session using the thread ID directly as the backend session ID
     * (Python {@code _get_or_create_by_thread_id}), seeding new sessions with the initial
     * state plus protected markers.
     *
     * @param mapping stable thread mapping
     * @param initialState optional initial state for a newly created session
     * @return the ADK session
     */
    private Single<Session> getOrCreateByThreadId(SessionMapping mapping, Map<String, Object> initialState) {
        SessionMappingKey key = mapping.key();
        return readSessionCached(key.appName(), key.userId(), mapping.sessionId())
                .switchIfEmpty(Single.defer(() -> sessionService.createSession(
                        key.appName(), key.userId(),
                        seededState(initialState, key.threadId(), key.appName(), key.userId()),
                        mapping.sessionId())));
    }

    /**
     * Gets or creates a generated-ID session, scanning the backend for the thread marker
     * unless the caller already confirmed a negative scan, mirroring Python
     * {@code _get_or_create_by_scan}.
     *
     * @param key AG-UI thread identity
     * @param initialState optional initial state for a newly created session
     * @param skipFind whether a negative thread-marker scan is already known
     * @return the ADK session
     */
    private Single<Session> getOrCreateByScan(
            SessionMappingKey key, Map<String, Object> initialState, boolean skipFind) {
        Maybe<Session> recovery = skipFind
                ? Maybe.empty()
                : sessionService.listSessions(key.appName(), key.userId())
                        .flatMapMaybe(response -> response.sessions().stream()
                                .filter(session -> key.threadId().equals(
                                        session.state().get(SessionStateKeys.THREAD_ID)))
                                .findFirst()
                                .map(Maybe::just)
                                .orElseGet(Maybe::empty));
        return recovery.switchIfEmpty(Single.defer(() -> sessionService.createSession(
                key.appName(), key.userId(),
                seededState(initialState, key.threadId(), key.appName(), key.userId()), null)));
    }

    /**
     * Builds the protected seed state for a newly created session.
     *
     * @param initialState caller-supplied initial state
     * @param threadId AG-UI thread identity
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @return mutable seed state
     */
    private static ConcurrentMap<String, Object> seededState(
            Map<String, Object> initialState, String threadId, String appName, String userId) {
        ConcurrentMap<String, Object> state = new ConcurrentHashMap<>();
        if (initialState != null) {
            initialState.forEach(state::put);
        }
        state.put(SessionStateKeys.THREAD_ID, threadId);
        state.put(SessionStateKeys.APP_NAME, appName);
        state.put(SessionStateKeys.USER_ID, userId);
        return state;
    }

    /**
     * Verifies persisted pending tool-call markers on first local access of a session
     * (Python {@code ADKAgent._verify_pending_tool_calls}, M-11): the verification runs at
     * most once per (appName, userId, threadId) per instance; markers are cleared only when
     * no active execution on this instance can fulfill them, and are preserved otherwise.
     *
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @param sessionId backend session identifier
     * @param threadId AG-UI thread identity
     * @param hasActiveExecution whether an execution for this thread is active on this instance
     * @return completion after the one-shot verification
     */
    public Completable verifyPendingToolCalls(
            String appName, String userId, String sessionId, String threadId,
            java.util.function.BooleanSupplier hasActiveExecution) {
        Objects.requireNonNull(appName, "appName");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(sessionId, "sessionId");
        Objects.requireNonNull(threadId, "threadId");
        PendingVerificationKey key = new PendingVerificationKey(appName, userId, threadId);
        if (!verifiedPendingCallThreads.add(key)) {
            return Completable.complete();
        }
        return sessionService.getSession(appName, userId, sessionId, Optional.empty())
                .flatMapCompletable(session -> {
                    Collection<?> pending = pendingToolCallIds(session);
                    if (pending == null || pending.isEmpty()) {
                        return Completable.complete();
                    }
                    if (hasActiveExecution != null && hasActiveExecution.getAsBoolean()) {
                        return Completable.complete();
                    }
                    logger.info(
                            "Clearing {} stale pending tool calls for thread {} (session {}, "
                                    + "no active execution on this instance)",
                            pending.size(), threadId, sessionId);
                    return updatePendingToolCallIds(session, Set.of());
                })
                .onErrorResumeNext(error -> {
                    logger.error("Failed to verify pending tool calls for session {}.",
                            sessionId, error);
                    return Completable.complete();
                });
    }

    /**
     * Extracts pending tool-call IDs stored in a session's state.
     *
     * @param session Google ADK session
     * @return stored pending IDs, or {@code null} when absent
     */
    private static Collection<?> pendingToolCallIds(Session session) {
        Object stored = session.state().get(PENDING_TOOL_CALL_IDS_KEY);
        return stored instanceof Collection<?> collection ? collection : null;
    }

    /**
     * Reports whether the background cleanup loop is currently running (M-10).
     *
     * @return whether the lazy scheduler task exists
     */
    public boolean cleanupTaskRunning() {
        return cleanupTask.get() != null;
    }

    /**
     * Configures the background cleanup policy before its first start (M-10).
     *
     * <p>The policy is permanently immutable after cleanup first starts, matching Python's
     * constructor-fixed manager policy. Repeating the same policy remains idempotent.
     *
     * @param policy explicit expiry / interval / HITL-wait policy
     */
    public synchronized void configureCleanupPolicy(SessionCleanupPolicy policy) {
        SessionCleanupPolicy configured = Objects.requireNonNull(policy, "policy");
        if (cleanupPolicyFrozen && !configured.equals(cleanupPolicy)) {
            throw new IllegalStateException("cleanup policy is immutable after cleanup starts");
        }
        if (!cleanupPolicyFrozen) {
            cleanupPolicy = configured;
        }
    }

    /**
     * Registers process-local reservation cleanup for confirmed ADK session deletion.
     *
     * @param store reservation store owned by an agent sharing this manager
     */
    void registerMessageReservationStore(MessageReservationStore store) {
        messageReservationStores.add(Objects.requireNonNull(store, "store"));
    }

    /**
     * Acquires the process-local mutation guard for an accepted execution.
     *
     * <p>The returned lease must remain held through durable reservation finalization so confirmed
     * cleanup cannot evict then have the same identity recreated by a late finalizer.
     *
     * @param session resolved ADK session
     * @return one-shot release lease
     */
    Single<ExecutionLease> acquireExecutionMutationGuard(Session session) {
        SessionIdentity identity = sessionIdentity(session);
        return new Single<>() {
            @Override
            protected void subscribeActual(io.reactivex.rxjava3.core.SingleObserver<? super ExecutionLease> observer) {
                MutationGuardEntry entry = sessionMutationGuards.get(identity);
                if (entry == null) {
                    MutationGuardEntry candidate = new MutationGuardEntry(identity);
                    MutationGuardEntry existing = sessionMutationGuards.putIfAbsent(identity, candidate);
                    entry = existing == null ? candidate : existing;
                }
                MutationGuardEntry.Admission admission = entry.new Admission(observer);
                observer.onSubscribe(admission);
                entry.enqueue(admission);
            }
        };
    }

    /** Cancellation-aware FIFO admission queue for one session identity. */
    private final class MutationGuardEntry {
        private final SessionIdentity identity;
        private final ArrayDeque<Admission> waiters = new ArrayDeque<>();
        private boolean held;
        private Admission activeAdmission;
        private boolean draining;
        private boolean retiring;

        private MutationGuardEntry(SessionIdentity identity) {
            this.identity = identity;
        }

        /**
         * Enqueues one acquisition request unless confirmed deletion has retired this entry.
         *
         * @param admission request completion observer and cancellation owner
         */
        void enqueue(Admission admission) {
            boolean rejected;
            synchronized (this) {
                rejected = retiring;
                if (!rejected && !admission.isDisposed()) {
                    waiters.addLast(admission);
                }
            }
            if (rejected) {
                admission.failRetirement();
            } else {
                drain();
            }
        }

        /**
         * Removes a queued request when its downstream subscription is disposed.
         *
         * @param admission cancelled request
         * @param selected whether cancellation released a selected admission
         */
        private void cancel(Admission admission, boolean selected) {
            boolean remove;
            synchronized (this) {
                waiters.remove(admission);
                if (selected && activeAdmission == admission) {
                    held = false;
                    activeAdmission = null;
                }
                remove = isSettledRetirement();
            }
            if (selected) {
                drain();
            }
            removeIfRetired(remove);
        }

        /** Fails outstanding requests and retires this entry after its active lease settles. */
        void requestRetirement() {
            List<Admission> stale;
            boolean remove;
            synchronized (this) {
                retiring = true;
                stale = new ArrayList<>(waiters);
                waiters.clear();
                remove = isSettledRetirement();
            }
            stale.forEach(Admission::failRetirement);
            removeIfRetired(remove);
        }

        /**
         * Selects the oldest live queued request when the entry is free.
         *
         * @return selected admission, or {@code null} when none is available
         */
        private Admission nextAdmission() {
            while (!held && !waiters.isEmpty()) {
                Admission next = waiters.removeFirst();
                if (next.select()) {
                    held = true;
                    activeAdmission = next;
                    return next;
                }
            }
            return null;
        }

        /**
         * Releases the active lease exactly once and selects the next request.
         *
         * @param released one-shot release marker
         * @param releasedAdmission active request owning the released lease
         */
        private void release(AtomicBoolean released, Admission releasedAdmission) {
            boolean remove;
            synchronized (this) {
                if (!released.compareAndSet(false, true)) {
                    return;
                }
                if (activeAdmission != releasedAdmission) {
                    return;
                }
                held = false;
                activeAdmission = null;
                remove = isSettledRetirement();
            }
            drain();
            removeIfRetired(remove);
        }

        private boolean isSettledRetirement() {
            return retiring && !held && waiters.isEmpty();
        }

        /**
         * Removes this exact settled entry without holding its monitor.
         *
         * @param remove whether retirement is settled
         */
        private void removeIfRetired(boolean remove) {
            if (remove) {
                sessionMutationGuards.remove(identity, this);
            }
        }

        /** Drains queued admissions iteratively outside the entry monitor. */
        private void drain() {
            synchronized (this) {
                if (draining) {
                    return;
                }
                draining = true;
            }
            while (true) {
                Admission admission;
                boolean remove;
                synchronized (this) {
                    admission = retiring ? null : nextAdmission();
                    if (admission == null) {
                        draining = false;
                        remove = isSettledRetirement();
                    } else {
                        remove = false;
                    }
                }
                if (admission == null) {
                    removeIfRetired(remove);
                    return;
                }
                AtomicBoolean released = new AtomicBoolean();
                admission.deliver(() -> release(released, admission));
            }
        }

        /** A request selected for lease delivery. */
        private final class Admission implements io.reactivex.rxjava3.disposables.Disposable {
            private final io.reactivex.rxjava3.core.SingleObserver<? super ExecutionLease> observer;
            private boolean selected;
            private boolean cancelled;
            private boolean delivered;

            private Admission(io.reactivex.rxjava3.core.SingleObserver<? super ExecutionLease> observer) {
                this.observer = observer;
            }

            /**
             * Marks this request as selected when it is still live.
             *
             * @return whether cancellation had not already won
             */
            private synchronized boolean select() {
                if (cancelled) {
                    return false;
                }
                selected = true;
                return true;
            }

            /**
             * Transfers the lease only after this admission wins against disposal.
             *
             * @param lease lease now owned by the observer
             * @return whether delivery won the ownership race
             */
            private boolean deliver(ExecutionLease lease) {
                synchronized (this) {
                    if (cancelled) {
                        return false;
                    }
                    delivered = true;
                }
                try {
                    observer.onSuccess(lease);
                } catch (Throwable callbackFailure) {
                    closeAfterCallbackFailure(lease);
                    reportCallbackFailure(callbackFailure);
                }
                return true;
            }

            /**
             * Releases an unclaimed lease after a non-fatal delivery callback failure.
             *
             * @param lease unclaimed lease
             */
            private void closeAfterCallbackFailure(ExecutionLease lease) {
                try {
                    lease.close();
                } catch (Throwable releaseFailure) {
                    reportCallbackFailure(releaseFailure);
                }
            }

            @Override
            public void dispose() {
                boolean release;
                synchronized (this) {
                    if (cancelled || delivered) {
                        return;
                    }
                    cancelled = true;
                    release = selected;
                }
                cancel(this, release);
            }

            @Override
            public synchronized boolean isDisposed() {
                return cancelled || delivered;
            }

            /** Delivers terminal retirement failure when cancellation has not won. */
            private void failRetirement() {
                synchronized (this) {
                    if (cancelled || delivered) {
                        return;
                    }
                    cancelled = true;
                }
                try {
                    observer.onError(new IllegalStateException("session deleted before mutation admission"));
                } catch (Throwable callbackFailure) {
                    reportCallbackFailure(callbackFailure);
                }
            }

            /**
             * Reports a non-fatal downstream callback failure without breaking coordination.
             *
             * @param failure callback failure
             */
            private void reportCallbackFailure(Throwable failure) {
                Exceptions.throwIfFatal(failure);
                try {
                    RxJavaPlugins.onError(failure);
                } catch (Throwable pluginFailure) {
                    Exceptions.throwIfFatal(pluginFailure);
                }
            }
        }
    }

    /**
     * Marks a confirmed-deleted identity for conditional retirement.
     *
     * @param session confirmed-deleted session
     */
    private void requestMutationGuardRetirement(Session session) {
        MutationGuardEntry entry = sessionMutationGuards.get(sessionIdentity(session));
        if (entry != null) {
            entry.requestRetirement();
        }
    }

    /**
     * Reports whether generated thread-to-session mappings are process-safe and distributed.
     *
     * @return true when mapping updates provide distributed atomicity
     */
    public boolean hasDistributedAtomicMappings() {
        return mappingStore.isDistributedAtomic();
    }

    /**
     * Finds an existing session for replay without allocating a session or mapping.
     *
     * @param appName Google ADK application identity
     * @param userId authenticated principal identity
     * @param threadId AG-UI thread identity
     * @return existing session and mapping, or an empty signal
     */
    public Maybe<ResolvedSession> findExistingSession(String appName, String userId, String threadId) {
        SessionMappingKey key = new SessionMappingKey(appName, userId, threadId);
        if (options.useThreadIdAsSessionId()) {
            SessionMapping mapping = new SessionMapping(key, threadId);
            return sessionService.getSession(appName, userId, threadId, Optional.empty())
                    .map(session -> new ResolvedSession(session, mapping));
        }
        return mappingStore.findMapping(key)
                .flatMap(this::findMappedSession)
                .switchIfEmpty(recoverGeneratedMapping(key).flatMap(this::findMappedSession));
    }

    /**
     * Reads a mapped session without creating it.
     *
     * @param mapping existing mapping
     * @return matching session and mapping, or an empty signal
     */
    private Maybe<ResolvedSession> findMappedSession(SessionMapping mapping) {
        SessionMappingKey key = mapping.key();
        return readSessionCached(key.appName(), key.userId(), mapping.sessionId())
                .map(session -> new ResolvedSession(session, mapping));
    }

    /**
     * Resolves a generated-ID session from a mapping, scan recovery, or a new allocation.
     *
     * @param key AG-UI thread identity
     * @return resolved ADK session and mapping
     */
    private Single<ResolvedSession> resolveGeneratedSession(SessionMappingKey key) {
        return mappingStore.getOrCreateMapping(key, () -> recoverGeneratedMapping(key)
                        .switchIfEmpty(Single.defer(() -> createGeneratedMapping(key))))
                .flatMap(mapping -> getOrCreateMappedSession(mapping)
                        .map(session -> new ResolvedSession(session, mapping)));
    }

    /**
     * Finds an existing generated session by its protected thread marker and restores its cache.
     *
     * @param key AG-UI thread identity
     * @return recovered mapping when a matching session exists
     */
    private Maybe<SessionMapping> recoverGeneratedMapping(SessionMappingKey key) {
        return sessionService.listSessions(key.appName(), key.userId())
                .flatMapMaybe(response -> response.sessions().stream()
                        .filter(session -> key.threadId().equals(session.state().get(SessionStateKeys.THREAD_ID)))
                        .findFirst()
                        .map(session -> Maybe.just(new SessionMapping(key, session.id())))
                        .orElseGet(Maybe::empty));
    }

    /**
     * Allocates a generated ADK session and atomically records its thread mapping.
     *
     * @param key AG-UI thread identity
     * @return created or concurrently recovered mapping
     */
    private Single<SessionMapping> createGeneratedMapping(SessionMappingKey key) {
        return sessionService.createSession(
                        key.appName(), key.userId(),
                        seededState(Map.of(), key.threadId(), key.appName(), key.userId()), null)
                .map(session -> new SessionMapping(key, session.id()));
    }

    /**
     * Reads the mapped session, creating it with its protected thread marker when needed.
     *
     * @param mapping stable thread mapping
     * @return ADK session
     */
    private Single<Session> getOrCreateMappedSession(SessionMapping mapping) {
        SessionMappingKey key = mapping.key();
        return readSessionCached(key.appName(), key.userId(), mapping.sessionId())
                .switchIfEmpty(Single.defer(() -> sessionService.createSession(
                        key.appName(), key.userId(),
                        seededState(Map.of(), key.threadId(), key.appName(), key.userId()),
                        mapping.sessionId())))
                .doOnSuccess(this::trackSession)
                // Python SessionManager.get_or_create_session starts the background cleanup
                // lazily on every get/create, for any manager (M-10).
                .doOnSuccess(ignored -> startCleanupTask());
    }

    /**
     * Deletes all sessions for one imported app and user pair.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @return completion signal
     */
    public Completable deleteAllUserAppNameSessions(String appName, String userId) {
        return sessionService.listSessions(appName, userId)
                .toFlowable()
                .map(ListSessionsResponse::sessions)
                .flatMapIterable(userSessions -> userSessions)
                .flatMapCompletable(this::hydrateArchiveAndDelete)
                .doOnComplete(() -> logger.info("Cleanup for user {} in app {} completed successfully.", userId, appName))
                .doOnError(ex -> logger.error("Failed to cleanup sessions for user {} in app {}.", userId, appName, ex));
    }

    /**
     * Explicitly cleans up one official ADK session using the canonical argument order.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @return completion after the authoritative session has been archived and deleted
     */
    public Completable cleanupSession(String appName, String userId, String sessionId) {
        Objects.requireNonNull(appName, "appName");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(sessionId, "sessionId");
        return sessionService.getSession(appName, userId, sessionId, Optional.empty())
                .flatMapCompletable(this::archiveAndDeleteSession);
    }

    /**
     * Deletes sessions expired at a caller-supplied instant for one app and user.
     *
     * <p>Applications own when this operation is invoked; this manager creates no scheduler.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param policy explicit session expiry policy
     * @param now deterministic cleanup reference time
     * @return completion after expired sessions have been archived and deleted
     */
    public Completable cleanupExpiredSessions(
            String appName, String userId, SessionCleanupPolicy policy, Instant now) {
        Objects.requireNonNull(appName, "appName");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(policy, "policy");
        Objects.requireNonNull(now, "now");
        CleanupKey key = new CleanupKey(appName, userId);
        return inFlightCleanup.computeIfAbsent(key, ignored -> {
            AtomicReference<Completable> computation = new AtomicReference<>();
            // Mirror Python SessionManager._cleanup_expired_sessions: an expired session that
            // still has pending (HITL) tool calls is preserved instead of deleted — indefinitely
            // when hitlMaxWait is null, otherwise until it has been preserved for hitlMaxWait.
            java.util.function.Function<Session, Completable> delete = listed -> hitlAwareDelete(listed, policy, now);
            Completable cleanup = Completable.defer(() -> sessionService
                            .listSessions(appName, userId)
                            .flatMapCompletable(response -> new SessionCleanupService(policy, delete)
                                    .cleanup(response.sessions(), now)))
                    .cache()
                    .doOnComplete(() -> inFlightCleanup.remove(key, computation.get()))
                    .doOnError(error -> inFlightCleanup.remove(key, computation.get()));
            computation.set(cleanup);
            return cleanup;
        });
    }

    /**
     * Deletes an expired session unless it is an active HITL session within the preservation
     * window: hydrates the authoritative session, and when it still has pending tool calls it is
     * preserved (skipped) — indefinitely when {@code hitlMaxWait} is null, else until it has been
     * preserved for {@code hitlMaxWait} (Python {@code _cleanup_expired_sessions} HITL branch).
     *
     * @param listed metadata-only session from the listing
     * @param policy explicit expiry / HITL-wait policy
     * @param now deterministic cleanup reference time
     * @return completion after the decision
     */
    private Completable hitlAwareDelete(Session listed, SessionCleanupPolicy policy, Instant now) {
        // Archive-only cycles untrack and forget the session; a later cleanup listing must not
        // re-archive it (Python iterates only tracked sessions, this bridge lists the backend).
        if (archivedSessionKeys.contains(archivedSessionKey(listed))) {
            return Completable.complete();
        }
        return sessionService.getSession(listed.appName(), listed.userId(), listed.id(), Optional.empty())
                .flatMapCompletable(session -> preserveHitlSession(session, policy, now)
                        ? Completable.complete()
                        : archiveAndDeleteSession(session));
    }

    /**
     * Decides whether an expired session with pending tool calls should be preserved. Clears the
     * preservation marker once the session has no more pending calls, and marks the first instant a
     * session is preserved so a configured {@code hitlMaxWait} limits how long it may survive.
     *
     * @param session authoritative (hydrated) session
     * @param policy explicit expiry / HITL-wait policy
     * @param now deterministic cleanup reference time
     * @return {@code true} to preserve (skip deletion)
     */
    private boolean preserveHitlSession(Session session, SessionCleanupPolicy policy, Instant now) {
        String key = session.appName() + ":" + session.id();
        if (!hasPendingToolCalls(session)) {
            hitlPreservedSince.remove(key);
            return false;
        }
        Duration hitlMaxWait = policy.hitlMaxWait();
        if (hitlMaxWait == null) {
            return true;
        }
        Instant since = hitlPreservedSince.computeIfAbsent(key, ignored -> now);
        boolean withinWait = now.isBefore(since.plus(hitlMaxWait));
        if (!withinWait) {
            hitlPreservedSince.remove(key);
        }
        return withinWait;
    }

    /**
     * Whether a session still has pending (HITL) tool calls tracked in its state.
     *
     * @param session authoritative session
     * @return whether pending tool-call ids are present
     */
    private boolean hasPendingToolCalls(Session session) {
        Object stored = session.state().get(PENDING_TOOL_CALL_IDS_KEY);
        return stored instanceof java.util.Collection<?> collection && !collection.isEmpty();
    }

    /**
     * Hydrates a metadata-only list entry before archival. A concurrently vanished
     * session is already clean and therefore needs no further work.
     *
     * @param listed session returned by listSessions
     * @return completion after the authoritative session is deleted
     */
    private Completable hydrateArchiveAndDelete(Session listed) {
        return sessionService.getSession(listed.appName(), listed.userId(), listed.id(), Optional.empty())
                .flatMapCompletable(this::archiveAndDeleteSession);
    }

    /**
     * Gets or creates a session and reads processed message IDs.
     *
     * @param context current run context
     * @return session and processed IDs
     */
    Single<SessionWithProcessedIds> getSessionAndProcessedMessageIds(RunContext context) {
        return getOrCreateSession(context)
            .flatMap(session -> getProcessedMessageIds(session)
                    .map(processedIds -> new SessionWithProcessedIds(session, processedIds))
            );
    }

    /**
     * Validates tool results against pending tool-call IDs.
     *
     * @param session Google ADK session
     * @param toolMessages official tool messages
     * @param toolCallIdToName tool-call lookup
     * @return accepted tool results
     */
    Flowable<ToolResult> processToolResults(
            Session session,
            List<Message> toolMessages,
            Map<String, String> toolCallIdToName) {
        return getPendingToolCallIds(session)
                .collect(Collectors.toSet())
                .flatMapPublisher(pendingIds -> finalizeToolResults(session, toolMessages, toolCallIdToName, pendingIds));
    }

    /**
     * Appends processed message IDs to session state.
     *
     * @param session Google ADK session
     * @param messageIds processed message IDs
     * @return completion signal
     */
    public Completable markMessagesProcessed(Session session, List<String> messageIds) {
        return Optional.ofNullable(messageIds)
                .filter(ids -> !ids.isEmpty())
                .map(ids -> processAndAppendEvent(session, ids, Map.of()))
                .orElse(Completable.complete());
    }

    /**
     * Appends accepted messages and their durable wire fingerprints atomically in one state delta.
     *
     * @param session Google ADK session
     * @param messages accepted AG-UI messages
     * @return completion signal
     */
    public Completable markMessagesProcessedWithFingerprints(Session session, Collection<Message> messages) {
        if (messages == null || messages.isEmpty()) {
            return Completable.complete();
        }
        Map<String, String> fingerprints = messages.stream()
                .filter(Objects::nonNull)
                .filter(message -> message.id() != null)
                .collect(Collectors.toMap(Message::id, MessageFingerprint::of, (first, ignored) -> first));
        return processAndAppendEvent(session, new ArrayList<>(fingerprints.keySet()), fingerprints);
    }

    /**
     * Serializes the imported processed-message and fingerprint state append.
     *
     * @param session Google ADK session
     * @param ids processed message IDs
     * @param fingerprints wire fingerprints keyed by message ID
     * @return durable append completion
     */
    private Completable processAndAppendEvent(Session session, List<String> ids, Map<String, String> fingerprints) {
        return Completable.fromAction(() -> {
            synchronized (writeLockFor(session)) {
                SessionIdentity identity = sessionIdentity(session);
                ProcessedMessageState prior = processedMessageStates.get(identity);
                ProcessedMessageState candidate = (prior == null
                        ? ProcessedMessageState.from(session.state())
                        : prior).withMerged(ids, fingerprints);
                Map<String, Object> stateDelta = new HashMap<>();
                stateDelta.put(PROCESSED_MESSAGE_IDS_KEY, new LinkedHashSet<>(candidate.ids));
                if (!candidate.fingerprints.isEmpty()) {
                    stateDelta.put(FINGERPRINTS_STATE_KEY, new TreeMap<>(candidate.fingerprints));
                }
                EventActions actions = EventActions.builder().stateDelta(stateDelta).build();

                Event event = Event.builder()
                        .invocationId("processed_messages_" + Instant.now().toEpochMilli())
                        .author("system")
                        .actions(actions)
                        .timestamp(Instant.now().toEpochMilli())
                        .build();

                sessionService.appendEvent(session, event).ignoreElement().blockingAwait();
                processedMessageStates.put(identity, candidate);
            }
        }).subscribeOn(Schedulers.io());
    }

    /**
     * Process-local identity for state writes. ADK session IDs are only scoped within an app and user.
     */
    private record SessionIdentity(String appName, String userId, String sessionId) {
    }

    /**
     * Internal helper.
     * @param session value
     * @return result
     */
    private Object writeLockFor(Session session) {
        return sessionWriteLocks.computeIfAbsent(sessionIdentity(session), k -> new Object());
    }

    /**
     * Internal helper.
     * @param session value
     * @return result
     */
    private static SessionIdentity sessionIdentity(Session session) {
        return new SessionIdentity(session.appName(), session.userId(), session.id());
    }

    /** Mutable cached snapshot that survives immutable ADK Session views in this process. */
    private static final class ProcessedMessageState {
        private final Set<String> ids;
        private final Map<String, String> fingerprints;

        private ProcessedMessageState(Set<String> ids, Map<String, String> fingerprints) {
            this.ids = ids;
            this.fingerprints = fingerprints;
        }

        /**
         * Loads the cached state from a session snapshot.
         *
         * @param state ADK session state
         * @return normalized processed-message state
         */
        private static ProcessedMessageState from(Map<String, Object> state) {
            return new ProcessedMessageState(stringSet(state.get(PROCESSED_MESSAGE_IDS_KEY)),
                    fingerprintMap(state.get(FINGERPRINTS_STATE_KEY)));
        }

        /**
         * Builds an independent merged state for an append candidate.
         *
         * @param newIds processed IDs for the candidate append
         * @param newFingerprints fingerprints for the candidate append
         * @return candidate state that does not alias the cached state
         */
        private ProcessedMessageState withMerged(Collection<String> newIds, Map<String, String> newFingerprints) {
            Set<String> mergedIds = new LinkedHashSet<>(ids);
            mergedIds.addAll(newIds);
            Map<String, String> mergedFingerprints = new HashMap<>(fingerprints);
            mergedFingerprints.putAll(newFingerprints);
            return new ProcessedMessageState(mergedIds, mergedFingerprints);
        }
    }

    /**
     * Internal helper.
     * @param value value
     * @return result
     */
    private static Set<String> stringSet(Object value) {
        if (value instanceof String json && json.startsWith("[")) {
            try {
                value = JSON.readValue(json, new TypeReference<Collection<Object>>() { });
            } catch (Exception ignored) {
                return new LinkedHashSet<>();
            }
        }
        Set<String> values = new LinkedHashSet<>();
        if (value instanceof Collection<?> collection) {
            collection.stream().filter(String.class::isInstance).map(String.class::cast).forEach(values::add);
        } else if (value != null && value.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(value);
            for (int index = 0; index < length; index++) {
                Object item = java.lang.reflect.Array.get(value, index);
                if (item instanceof String string) {
                    values.add(string);
                }
            }
        }
        return values;
    }

    /**
     * Internal helper.
     * @param value value
     * @return result
     */
    private static Map<String, String> fingerprintMap(Object value) {
        if (value instanceof String json && json.startsWith("{")) {
            try {
                value = JSON.readValue(json, new TypeReference<Map<String, Object>>() { });
            } catch (Exception ignored) {
                return new HashMap<>();
            }
        }
        Map<String, String> fingerprints = new HashMap<>();
        if (value instanceof Map<?, ?> rawMap) {
            rawMap.forEach((id, fingerprint) -> {
                if (id instanceof String stringId && fingerprint instanceof String stringFingerprint) {
                    fingerprints.put(stringId, stringFingerprint);
                }
            });
        }
        return fingerprints;
    }

    /**
     * Gets or creates the Google ADK session for a run.
     *
     * @param context current run context
     * @return session signal
     */
    private Single<Session> getOrCreateSession(RunContext context) {
        String sessionId = context.sessionId();
        String appName = context.appName();
        String userId = context.userId();

        return sessionService.getSession(appName, userId, sessionId, Optional.empty())
                .doOnSuccess(session -> {
                    logger.debug("Reusing existing session: {} for appname  : {} and user: {}", sessionId, appName, userId);
                    trackSession(session);
                })
                .switchIfEmpty(Single.defer(() -> {
                    logger.info("Creating new session: {} for appname  : {} and user: {}", sessionId, appName, userId);
                    // Enforce the per-user concurrency cap before creating: if this user is at
                    // (or over) their max concurrently tracked sessions, evict the least recently
                    // updated one first (Python SessionManager._remove_oldest_user_session).
                    return enforcePerUserLimit(userId)
                            .andThen(sessionService.createSession(appName, userId, null, sessionId))
                            .doOnSuccess(this::trackSession);
                }))
                // Python SessionManager.get_or_create_session starts the background cleanup
                // lazily on every get/create, for any manager (M-10).
                .doOnSuccess(ignored -> startCleanupTask());
    }

    /**
     * Evicts the least recently updated tracked session for a user when they are at (or over)
     * their configured per-user concurrent-session cap; a no-op when the cap is unlimited.
     *
     * @param userId Google ADK user identifier
     * @return completion after any single eviction
     */
    private Completable enforcePerUserLimit(String userId) {
        if (maxSessionsPerUser == null) {
            return Completable.complete();
        }
        java.util.Set<String> keys = concurrentUserKeys(userId, false);
        if (keys.size() < maxSessionsPerUser) {
            return Completable.complete();
        }
        return removeOldestUserSession(userId);
    }

    /**
     * Removes the oldest session for a user based on last update time, mirroring the Python
     * {@code SessionManager._remove_oldest_user_session}. Iterates every tracked session of the
     * user (across apps, like Python's per-user key set) and deletes the least recently updated.
     *
     * @param userId Google ADK user identifier
     * @return completion after the eviction
     */
    private Completable removeOldestUserSession(String userId) {
        java.util.Set<String> keys = concurrentUserKeys(userId, false);
        if (keys.isEmpty()) {
            return Completable.complete();
        }
        java.util.List<Single<Optional<Session>>> fetches = new java.util.ArrayList<>();
        for (String key : keys) {
            String[] parts = key.split(":", 2);
            if (parts.length != 2) {
                continue;
            }
            String keyApp = parts[0];
            String keyId = parts[1];
            fetches.add(sessionService.getSession(keyApp, userId, keyId, Optional.empty())
                    .map(Optional::of)
                    .defaultIfEmpty(Optional.empty())
                    .onErrorReturnItem(Optional.empty()));
        }
        if (fetches.isEmpty()) {
            return Completable.complete();
        }
        return Single.zip(fetches, results -> {
            Optional<Session> oldest = Optional.empty();
            Instant oldestTime = null;
            for (Object result : results) {
                Optional<Session> candidate = (Optional<Session>) result;
                if (candidate.isEmpty()) {
                    continue;
                }
                Session session = candidate.get();
                Instant updateTime = session.lastUpdateTime() != null
                        ? session.lastUpdateTime() : Instant.EPOCH;
                if (oldest.isEmpty() || updateTime.isBefore(oldestTime)) {
                    oldest = Optional.of(session);
                    oldestTime = updateTime;
                }
            }
            return oldest;
        }).flatMapCompletable(oldest -> oldest.isEmpty()
                ? Completable.complete()
                : hydrateArchiveAndDelete(oldest.get()).andThen(
                        Completable.fromAction(() -> untrackSession(oldest.get()))));
    }
    /**
     * Reads immutable processed IDs from session state.
     *
     * @param session Google ADK session
     * @return processed-ID signal
     */
    Single<Set<String>> getProcessedMessageIds(Session session) {
        ProcessedMessageState cached = processedMessageStates.get(sessionIdentity(session));
        Set<String> ids = cached == null
                ? stringSet(session.state().get(PROCESSED_MESSAGE_IDS_KEY))
                : cached.ids;
        return Single.just(Set.copyOf(ids));
    }
    /**
     * Finalizes accepted tool results and updates pending IDs.
     *
     * @param session Google ADK session
     * @param toolMessages official tool messages
     * @param toolCallIdToName tool-call lookup
     * @param pendingIds pending tool-call IDs
     * @return accepted tool results
     */
    private Flowable<ToolResult> finalizeToolResults(
            Session session,
            List<Message> toolMessages,
            Map<String, String> toolCallIdToName,
            Set<String> pendingIds) {
        ToolProcessingAccumulator toolProcessingAccumulator = accumulateValidToolResults(toolMessages, toolCallIdToName, pendingIds);

        if (toolProcessingAccumulator.validResults.isEmpty()) {
            return Flowable.empty();
        }

        Set<String> newPendingIds = new HashSet<>(pendingIds);
        newPendingIds.removeAll(toolProcessingAccumulator.processedIds);

        return updatePendingToolCallIds(session, newPendingIds)
                .andThen(Flowable.fromIterable(toolProcessingAccumulator.validResults));
    }

    /**
     * Accumulates valid imported tool results.
     *
     * @param toolMessages official tool messages
     * @param toolCallIdToName tool-call lookup
     * @param pendingIds pending tool-call IDs
     * @return reduction accumulator
     */
    private static ToolProcessingAccumulator accumulateValidToolResults(
            List<Message> toolMessages,
            Map<String, String> toolCallIdToName,
            Set<String> pendingIds) {
        return toolMessages.stream()
            .filter(baseMessage -> baseMessage instanceof ToolMessage)
            .map(baseMessage -> (ToolMessage) baseMessage)
            .reduce(
                new ToolProcessingAccumulator(new ArrayList<>(), new HashSet<>()), // Supplier
                    createToolProcessingAccumulatorFunction(toolCallIdToName, pendingIds),
                    createToolProcessingCombiner()
            );
    }
    /**
     * Creates the imported parallel-stream accumulator combiner.
     *
     * @return accumulator combiner
     */
    private static BinaryOperator<ToolProcessingAccumulator> createToolProcessingCombiner() {
        return (acc1, acc2) -> {
            acc1.validResults.addAll(acc2.validResults);
            acc1.processedIds.addAll(acc2.processedIds);
            return acc1;
        };
    }
    /**
     * Creates the imported tool-message accumulator function.
     *
     * @param toolCallIdToName tool-call lookup
     * @param pendingIds pending tool-call IDs
     * @return accumulator function
     */
    private static BiFunction<ToolProcessingAccumulator, ToolMessage, ToolProcessingAccumulator>
            createToolProcessingAccumulatorFunction(
                    Map<String, String> toolCallIdToName, Set<String> pendingIds) {
        return (acc, toolMessage) -> { // Accumulator
            String toolCallId = toolMessage.toolCallId();
            if (toolCallId == null || toolCallId.isBlank()) {
                throw new IllegalArgumentException("Tool result requires a non-blank tool-call ID");
            }
            String toolName = toolCallIdToName.getOrDefault(
                    toolCallId, ToolResultExtractor.UNKNOWN_NAME);

            if (pendingIds.contains(toolCallId) && !ToolResultExtractor.CONFIRM_CHANGES.equals(toolName)) {
                acc.validResults().add(new ToolResult(toolName, toolMessage));
                acc.processedIds().add(toolCallId);
            }
            return acc;
        };
    }

    /**
     * Reads pending tool-call IDs from session state.
     *
     * @param session Google ADK session
     * @return pending tool-call IDs
     */
    private Flowable<String> getPendingToolCallIds(Session session) {
        Object storedValue = session.state().get(PENDING_TOOL_CALL_IDS_KEY);
        if (storedValue instanceof Set) {
            return Flowable.fromIterable((Set<?>) storedValue)
                .filter(String.class::isInstance)
                .map(String.class::cast);
        }
        return Flowable.empty();
    }

    /**
     * Appends updated pending tool-call IDs to session state.
     *
     * @param session Google ADK session
     * @param updatedPendingIds updated pending IDs
     * @return completion signal
     */
    private Completable updatePendingToolCallIds(
            Session session, Set<String> updatedPendingIds) {
        // Same per-session serialization rationale as processAndAppendEvent. Even though the
        // caller passes a pre-computed Set, two concurrent writes for the same session would
        // race at appendEvent — one stateDelta would clobber the other.
        return Completable.fromAction(() -> {
            synchronized (writeLockFor(session)) {
                Map<String, Object> stateDelta = new HashMap<>();
                stateDelta.put(PENDING_TOOL_CALL_IDS_KEY, updatedPendingIds);
                EventActions actions = EventActions.builder().stateDelta(stateDelta).build();

                Event event = Event.builder()
                        .invocationId("updated_pending_tool_calls_" + Instant.now().toEpochMilli())
                        .author("system")
                        .actions(actions)
                        .timestamp(Instant.now().toEpochMilli())
                        .build();

                sessionService.appendEvent(session, event).ignoreElement().blockingAwait();
            }
        }).subscribeOn(Schedulers.io());
    }

    /**
     * Archives and deletes one session under the two independently configured cleanup policies
     * (Python {@code SessionManager._delete_session}): memory ingestion happens only when
     * {@code saveSessionToMemoryOnCleanup} is enabled and never blocks the deletion attempt
     * (M-09/M-21); the backend deletion happens only when {@code deleteSessionOnCleanup} is
     * enabled. Either way the session is untracked once the decision completes, so an
     * archive-only cycle never re-archives the same session on a later cleanup run.
     *
     * @param session Google ADK session
     * @return completion signal
     */
    public Completable archiveAndDeleteSession(Session session) {
        return acquireExecutionMutationGuard(session)
                .flatMapCompletable(guard -> archiveAndDeleteSessionInternal(session)
                        .doFinally(guard::close));
    }

    /**
     * Runs the independently configured archival/deletion decision for one session.
     *
     * @param session Google ADK session
     * @return completion signal
     */
    private Completable archiveAndDeleteSessionInternal(Session session) {
        // Independent memory-ingestion policy: a memory failure is logged and swallowed so the
        // deletion attempt always happens (Python catches the memory error and continues).
        Completable memoryIngestion = options.saveSessionToMemoryOnCleanup() && memoryService != null
                ? Completable.defer(() -> memoryService.addSessionToMemory(session))
                        .doOnError(ex -> logger.error("Failed to save session {} to memory.", session.id(), ex))
                        .onErrorComplete()
                : Completable.complete();
        // Independent backend-deletion policy. Deletion failures still propagate (the mutation
        // guard and reservation state must survive), matching the confirmed-deletion contract.
        Completable backendDeletion = options.deleteSessionOnCleanup()
                ? Completable.defer(() -> sessionService.deleteSession(
                                session.appName(), session.userId(), session.id())
                        .andThen(Completable.fromAction(() -> evictManagerLocalState(session)))
                        .andThen(Completable.fromAction(() -> requestMutationGuardRetirement(session)))
                        .andThen(evictRegisteredReservationStateAndInvalidateMapping(session))
                        .doOnComplete(() -> logger.info("Session {} deleted.", session.id()))
                        .doOnError(ex -> logger.error("Failed to delete session {}.", session.id())))
                : Completable.complete();
        return memoryIngestion
                .andThen(backendDeletion)
                .andThen(Completable.fromAction(() -> {
                    untrackSession(session);
                    archivedSessionKeys.add(archivedSessionKey(session));
                }));
    }

    /**
     * Returns the manager-local archive key of a session.
     *
     * @param session Google ADK session
     * @return {@code appName:sessionId} key
     */
    private static String archivedSessionKey(Session session) {
        return session.appName() + ":" + session.id();
    }

    /**
     * Removes manager-local state once ADK has confirmed deletion.
     *
     * @param session confirmed deleted session
     */
    private void evictManagerLocalState(Session session) {
        SessionIdentity identity = sessionIdentity(session);
        sessionWriteLocks.remove(identity);
        processedMessageStates.remove(identity);
    }

    /**
     * Evicts every registered process-local reservation store after confirmed deletion.
     *
     * @param session confirmed deleted session
     * @return reservation-state eviction completion
     */
    private Completable evictRegisteredReservationStateAndInvalidateMapping(Session session) {
        List<Completable> postDeleteActions;
        synchronized (messageReservationStores) {
            postDeleteActions = messageReservationStores.stream()
                    .map(store -> Completable.defer(() -> store.evict(session)))
                    .collect(Collectors.toCollection(ArrayList::new));
        }
        postDeleteActions.add(Completable.defer(() -> invalidateThreadMapping(session)));
        return Completable.concatArrayDelayError(postDeleteActions.toArray(Completable[]::new));
    }

    /**
     * Drops a generated-ID mapping after its corresponding ADK session is deleted.
     *
     * @param session deleted ADK session
     * @return mapping invalidation completion
     */
    private Completable invalidateThreadMapping(Session session) {
        if (options.useThreadIdAsSessionId()) {
            return Completable.complete();
        }
        Object threadId = session.state().get(SessionStateKeys.THREAD_ID);
        if (!(threadId instanceof String id) || id.isBlank()) {
            return Completable.complete();
        }
        return mappingStore.invalidate(new SessionMappingKey(session.appName(), session.userId(), id));
    }

    /**
     * Tracks one resolved session under its owning user for enumeration and per-user eviction.
     *
     * @param session resolved ADK session
     */
    public void trackSession(Session session) {
        String key = session.appName() + ":" + session.id();
        userSessionKeys.computeIfAbsent(session.userId(), ignored -> java.util.concurrent.ConcurrentHashMap.newKeySet())
                .add(key);
        // A re-acquired session is active again: it becomes eligible for a future cleanup
        // decision instead of staying in the archive-only skip set (Python re-tracks it).
        archivedSessionKeys.remove(key);
    }

    /**
     * Drops a session from per-user tracking.
     *
     * @param session ADK session
     */
    private void untrackSession(Session session) {
        String key = session.appName() + ":" + session.id();
        // Cleanup may archive sessions that were never tracked (backend-listing driven), so
        // the user key set can be absent; the immutable getOrDefault default must not be mutated.
        java.util.Set<String> keys = userSessionKeys.get(session.userId());
        if (keys != null) {
            keys.remove(key);
        }
    }

    /**
     * Returns the per-user session-key set, optionally creating it.
     *
     * @param userId Google ADK user identifier
     * @param create whether to create the set when absent
     * @return the user's session-key set
     */
    private java.util.Set<String> concurrentUserKeys(String userId, boolean create) {
        return create
                ? userSessionKeys.computeIfAbsent(userId, ignored -> java.util.concurrent.ConcurrentHashMap.newKeySet())
                : userSessionKeys.getOrDefault(userId, java.util.Set.of());
    }

    /**
     * Returns the current count of tracked sessions, mirroring Python
     * {@code get_session_count()}.
     *
     * @return number of sessions across all users and apps
     */
    public int getSessionCount() {
        return userSessionKeys.values().stream().mapToInt(Set::size).sum();
    }

    /**
     * Returns the number of tracked sessions for one user, mirroring Python
     * {@code get_user_session_count(user_id)}.
     *
     * @param userId Google ADK user identifier
     * @return number of sessions for the user
     */
    public int getUserSessionCount(String userId) {
        return userSessionKeys.getOrDefault(userId, Set.of()).size();
    }

    /**
     * Drops any pending per-invocation {@code temp:} state for the given backend session, so a
     * later run on the same session does not inherit stale values (e.g. a rotated bearer token).
     *
     * <p>Port of the P1 #17 temp-state rotation cleanup ({@code adk_agent.py} L3455-3463): after a
     * run completes the bridge clears the per-invocation temp state it injected via
     * {@link RequestStateSessionService}. No-op when the wrapped session service is not a
     * {@link RequestStateSessionService}.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId backend session identifier
     */
    public void clearPendingRequestTempState(String appName, String userId, String sessionId) {
        if (sessionService instanceof RequestStateSessionService requestState) {
            requestState.clearPendingTempState(appName, userId, sessionId);
        }
    }

    /**
     * Builds and persists a user-authored state-delta event through the ADK session service.
     *
     * @param session resolved ADK session
     * @param stateDelta state entries to set or remove
     * @return completion when the state update is persisted
     */
    private Completable appendStateDelta(Session session, Map<String, Object> stateDelta) {
        if (stateDelta == null || stateDelta.isEmpty()) {
            return Completable.complete();
        }
        EventActions actions = EventActions.builder().stateDelta(stateDelta).build();
        Event event = Event.builder()
                .invocationId("state_update_" + Instant.now().toEpochMilli())
                .author("user")
                .actions(actions)
                .timestamp(Instant.now().toEpochMilli())
                .build();
        return sessionService.appendEvent(session, event).ignoreElement();
    }

    /**
     * Updates session state by persisting a state-delta event, mirroring Python
     * {@code update_session_state} (merge/isolation handled by callers choosing deltas).
     *
     * @param session     resolved ADK session
     * @param stateUpdates state entries to set
     * @return completion when persisted
     */
    public Completable updateSessionState(Session session, Map<String, Object> stateUpdates) {
        if (session == null || stateUpdates == null || stateUpdates.isEmpty()) {
            return Completable.complete();
        }
        invalidateSession(session.appName(), session.userId(), session.id());
        return appendStateDelta(session, stateUpdates);
    }

    /**
     * Sets one state key to a value, mirroring Python {@code set_state_value}.
     *
     * @param session resolved ADK session
     * @param key     state key
     * @param value   value to set
     * @return completion when persisted
     */
    public Completable setStateValue(Session session, String key, Object value) {
        return appendStateDelta(session, Map.of(key, value));
    }

    /**
     * Removes requested state keys by persisting removal markers, mirroring Python
     * {@code remove_state_keys}.
     *
     * @param session resolved ADK session
     * @param keys    keys to remove
     * @return completion when persisted
     */
    public Completable removeStateKeys(Session session, Iterable<String> keys) {
        Map<String, Object> removal = new LinkedHashMap<>();
        for (String key : keys) {
            if (session.state().containsKey(key)) {
                removal.put(key, com.google.adk.sessions.State.REMOVED);
            }
        }
        return appendStateDelta(session, removal);
    }

    /**
     * Clears all session state except keys whose name has one of the preserved prefixes,
     * mirroring Python {@code clear_session_state}.
     *
     * @param session          resolved ADK session
     * @param preservePrefixes prefixes to preserve
     * @return completion when persisted
     */
    public Completable clearSessionState(Session session, Collection<String> preservePrefixes) {
        Set<String> preserved = preservePrefixes == null ? Set.of() : Set.copyOf(preservePrefixes);
        Map<String, Object> removal = new LinkedHashMap<>();
        for (String key : session.state().keySet()) {
            boolean keep = preserved.stream().anyMatch(key::startsWith);
            if (!keep) {
                removal.put(key, com.google.adk.sessions.State.REMOVED);
            }
        }
        return appendStateDelta(session, removal);
    }

    /**
     * Initializes session state with default values without overwriting existing keys,
     * mirroring Python {@code initialize_session_state}.
     *
     * @param session        resolved ADK session
     * @param initialState   default state entries
     * @param overwriteExisting whether to overwrite existing values
     * @return completion when persisted
     */
    public Completable initializeSessionState(
            Session session, Map<String, Object> initialState, boolean overwriteExisting) {
        if (initialState == null || initialState.isEmpty()) {
            return Completable.complete();
        }
        Map<String, Object> toSet = new LinkedHashMap<>();
        initialState.forEach((key, value) -> {
            boolean exists = session.state().containsKey(key);
            if (overwriteExisting || !exists) {
                toSet.put(key, value);
            }
        });
        return appendStateDelta(session, toSet);
    }

    /**
     * Returns the current session state as an immutable map, mirroring Python
     * {@code get_session_state}.
     *
     * @param session resolved ADK session
     * @return immutable snapshot of session state
     */
    public Map<String, Object> getSessionState(Session session) {
        Map<String, Object> copy = new LinkedHashMap<>();
        session.state().forEach(copy::put);
        return Collections.unmodifiableMap(copy);
    }

    /**
     * Returns one state value or a default, mirroring Python {@code get_state_value}.
     *
     * @param session resolved ADK session
     * @param key     state key
     * @param defaultVal value returned when the key is absent
     * @return the stored value or {@code defaultVal}
     */
    public Object getStateValue(Session session, String key, Object defaultVal) {
        return session.state().containsKey(key) ? session.state().get(key) : defaultVal;
    }

    /**
     * Updates state across every tracked session of one user (optionally filtered by app),
     * mirroring Python {@code bulk_update_user_state}.
     *
     * @param userId        Google ADK user identifier
     * @param stateUpdates  state entries to set across the user's sessions
     * @param appNameFilter optional app filter; null means all apps
     * @return stream of per-session update completions
     */
    public io.reactivex.rxjava3.core.Flowable<java.util.Map.Entry<String, Boolean>> bulkUpdateUserState(
            String userId, Map<String, Object> stateUpdates, String appNameFilter) {
        if (stateUpdates == null || stateUpdates.isEmpty()) {
            return io.reactivex.rxjava3.core.Flowable.empty();
        }
        List<String> keys = new ArrayList<>(concurrentUserKeys(userId, false));
        return io.reactivex.rxjava3.core.Flowable.fromIterable(keys)
                .filter(key -> appNameFilter == null || key.startsWith(appNameFilter + ":"))
                .filter(key -> !key.startsWith(":"))
                .concatMapEager(key -> {
                    int sep = key.indexOf(':');
                    String sessionId = key.substring(sep + 1);
                    String appName = key.substring(0, sep);
                    io.reactivex.rxjava3.core.Flowable<java.util.Map.Entry<String, Boolean>> absent =
                            io.reactivex.rxjava3.core.Flowable.just(Map.<String, Boolean>entry(key, false));
                    return sessionService.getSession(appName, userId, sessionId, Optional.empty())
                            .toFlowable()
                            .flatMap(session -> updateAccepts(session, stateUpdates)
                                    ? updateOneEntry(session, key, stateUpdates)
                                    : absent);
                });
    }


    private static boolean updateAccepts(Session session, Map<String, Object> stateUpdates) {
        return session != null && stateUpdates != null && !stateUpdates.isEmpty();
    }

    /**
     * Persists one user's state update and reports success per session key.
     *
     * @param session resolved ADK session
     * @param key      session key
     * @param updates  state entries
     * @return success-flag stream
     */
    private io.reactivex.rxjava3.core.Flowable<java.util.Map.Entry<String, Boolean>> updateOneEntry(
            Session session, String key, Map<String, Object> updates) {
        return appendStateDelta(session, updates)
                .toSingleDefault(Map.<String, Boolean>entry(key, true))
                .onErrorReturn(ignored -> Map.<String, Boolean>entry(key, false))
                .toFlowable();
    }

    /**
     * Starts a short-lived per-execution cache for repeated session reads, returning a token
     * used by {@link #stopSessionReadCache}. The ContextVar-equivalent of Python
     * {@code SessionManager.start_session_read_cache}: subsequent cached session reads within
     * the current execution context reuse the first result instead of hitting the service.
     *
     * @return a token restoring the prior cache state on {@link #stopSessionReadCache}
     */
    public ReadCacheToken startSessionReadCache() {
        long openingThreadId = Thread.currentThread().getId();
        Map<SessionCacheKey, Session> previous = sessionReadCaches.get(openingThreadId);
        sessionReadCaches.put(openingThreadId, new HashMap<>());
        return new ReadCacheToken(previous, openingThreadId);
    }

    /**
     * Restores the read-cache state captured by {@link #startSessionReadCache} (Python
     * {@code stop_session_read_cache}).
     *
     * @param token token from {@link #startSessionReadCache}
     */
    public void stopSessionReadCache(ReadCacheToken token) {
        if (token == null) {
            sessionReadCaches.remove(Thread.currentThread().getId());
            return;
        }
        // The execution may settle on a scheduler thread while the cache was opened on the
        // subscribing thread; close both so neither leaks and the opening thread never serves a
        // stale session on a later run (audit finding M-12).
        sessionReadCaches.remove(Thread.currentThread().getId());
        sessionReadCaches.remove(token.openingThreadId);
        if (token.previous != null) {
            sessionReadCaches.put(token.openingThreadId, token.previous);
        }
    }

    /**
     * Disables session read caching for the remainder of the current execution context (Python
     * {@code disable_session_read_cache}): cached reads fall back to direct service reads.
     */
    public void disableSessionReadCache() {
        sessionReadCaches.remove(Thread.currentThread().getId());
    }

    /**
     * Removes a session from the current execution context's read cache, if present (Python
     * {@code SessionManager.invalidate_session}).
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     */
    public void invalidateSession(String appName, String userId, String sessionId) {
        Map<SessionCacheKey, Session> cache = sessionReadCaches.get(Thread.currentThread().getId());
        if (cache != null) {
            cache.remove(new SessionCacheKey(appName, userId, sessionId));
        }
    }

    /**
     * Reads a session through the current execution context's read cache when one is active
     * (Python {@code _cache_session} + {@code _cache_key}): a cache miss reads from the service
     * and populates the cache; a disabled/stopped cache reads directly.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @return the session, or an empty signal when absent
     */
    private Maybe<Session> readSessionCached(String appName, String userId, String sessionId) {
        Map<SessionCacheKey, Session> cache = sessionReadCaches.get(Thread.currentThread().getId());
        if (cache == null) {
            return sessionService.getSession(appName, userId, sessionId, Optional.empty());
        }
        SessionCacheKey key = new SessionCacheKey(appName, userId, sessionId);
        Session cached = cache.get(key);
        if (cached != null) {
            return Maybe.just(cached);
        }
        return sessionService.getSession(appName, userId, sessionId, Optional.empty())
                .doOnSuccess(session -> cache.put(key, session));
    }

    /**
     * Releases all process-local resources owned by this manager (the session-manager step of
     * Python {@code ADKAgent.close}): stops the background cleanup task and clears the
     * per-execution session read caches and the processed-message state cache so no stale
     * session data survives the close. Idempotent; in-flight runs are cancelled by the owning
     * agent before this is invoked.
     */
    public void dispose() {
        stopCleanupTask();
        sessionReadCaches.clear();
        processedMessageStates.clear();
    }

    /** Closes session and memory services when their concrete implementations are closeable. */
    public void closeServices() {
        closeIfOwned(sessionService);
        if (memoryService != sessionService) {
            closeIfOwned(memoryService);
        }
    }

    /**
     * Closes one optional service capability.
     *
     * @param service optional closeable service
     */
    private static void closeIfOwned(Object service) {
        if (service instanceof AutoCloseable closeable) {
            try {
                closeable.close();
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw new IllegalStateException("Failed to close ADK service", error);
            }
        }
    }

    /**
     * Returns the process-wide default {@link SessionManager}, lazily constructed on first call
     * and reused thereafter (Python {@code SessionManager.get_default}). The default manager uses
     * an {@link com.google.adk.sessions.InMemorySessionService} with no memory service and starts
     * the background cleanup loop.
     *
     * @return the process-wide default session manager
     */
    public static SessionManager getDefault() {
        SessionManager current = defaultManager;
        if (current == null) {
            synchronized (SessionManager.class) {
                current = defaultManager;
                if (current == null) {
                    InMemoryThreadSessionMappingStore store = new InMemoryThreadSessionMappingStore();
                    current = new SessionManager(
                            new com.google.adk.sessions.InMemorySessionService(),
                            new com.google.adk.memory.InMemoryMemoryService(), store,
                            AdkAgUiOptions.defaults());
                    current.startCleanupTask();
                    defaultManager = current;
                }
            }
        }
        return current;
    }

    /**
     * Resets the process-wide default {@link SessionManager}, cancelling its background cleanup
     * task (Python {@code SessionManager.reset_default}, intended for tests).
     */
    public static void resetDefault() {
        synchronized (SessionManager.class) {
            if (defaultManager != null) {
                defaultManager.stopCleanupTask();
                defaultManager = null;
            }
        }
    }

    /**
     * Starts the background cleanup loop if it is not already running. Every {@code policy.interval()}
     * the loop cleans expired sessions across every tracked (app, user) pair (Python
     * {@code _start_cleanup_task} / {@code _cleanup_loop}); a running loop is never duplicated.
     *
     * @param policy explicit expiry / interval / HITL-wait policy
     */
    public synchronized void startCleanupTask(SessionCleanupPolicy policy) {
        if (policy != null) {
            configureCleanupPolicy(policy);
        }
        startCleanupTask();
    }

    /**
     * Starts the background cleanup loop with the currently configured policy if it is not
     * already running (Python {@code _start_cleanup_task}); idempotent.
     */
    public synchronized void startCleanupTask() {
        if (cleanupTask.get() != null) {
            return;
        }
        java.util.concurrent.ScheduledExecutorService scheduler = cleanupScheduler.get();
        if (scheduler == null) {
            scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "ag-ui-adk-session-cleanup");
                thread.setDaemon(true);
                return thread;
            });
            if (!cleanupScheduler.compareAndSet(null, scheduler)) {
                scheduler.shutdown();
                scheduler = cleanupScheduler.get();
            }
        }
        cleanupPolicyFrozen = true;
        SessionCleanupPolicy policy = this.cleanupPolicy;
        java.util.concurrent.ScheduledFuture<?> future = scheduler.scheduleWithFixedDelay(
                () -> runCleanupCycle(policy),
                policy.interval().toMillis(),
                policy.interval().toMillis(),
                java.util.concurrent.TimeUnit.MILLISECONDS);
        cleanupTask.set(future);
    }

    /**
     * Stops and cancels the background cleanup loop (Python {@code stop_cleanup_task}).
     */
    public synchronized void stopCleanupTask() {
        java.util.concurrent.ScheduledFuture<?> future = cleanupTask.getAndSet(null);
        if (future != null) {
            future.cancel(false);
        }
        java.util.concurrent.ScheduledExecutorService scheduler = cleanupScheduler.getAndSet(null);
        if (scheduler != null) {
            scheduler.shutdown();
        }
    }

    /**
     * Runs one cleanup cycle: cleans expired sessions across every tracked (app, user) pair
     * derived from {@link #userSessionKeys}. Errors are logged and never propagate to the loop.
     *
     * @param policy active cleanup policy
     */
    private void runCleanupCycle(SessionCleanupPolicy policy) {
        try {
            Set<AppUserPair> pairs = new java.util.HashSet<>();
            userSessionKeys.forEach((userId, keys) -> keys.forEach(key -> {
                int sep = key.indexOf(':');
                if (sep > 0) {
                    pairs.add(new AppUserPair(key.substring(0, sep), userId));
                }
            }));
            pairs.forEach(pair -> {
                try {
                    cleanupExpiredSessions(pair.appName(), pair.userId(), policy, Instant.now())
                            .subscribe(() -> { }, error ->
                                    logger.error("Background cleanup failed for user {} in app {}.",
                                            pair.userId(), pair.appName(), error));
                } catch (Exception error) {
                    logger.error("Background cleanup failed for user {} in app {}.",
                            pair.userId(), pair.appName(), error);
                }
            });
        } catch (Exception error) {
            logger.error("Session cleanup cycle failed.", error);
        }
    }

    /**
     * A tracked (app, user) pair over which the background cleanup loop runs.
     *
     * @param appName Google ADK application name
     * @param userId Google ADK user identifier
     */
    private record AppUserPair(String appName, String userId) {
    }

    /**
     * Returns the default background cleanup policy (20-minute expiry, 5-minute interval,
     * unlimited HITL preservation), mirroring the Python SessionManager defaults.
     *
     * @return the default cleanup policy
     */
    private static SessionCleanupPolicy defaultCleanupPolicy() {
        return new SessionCleanupPolicy(
                java.time.Duration.ofSeconds(1200), java.time.Duration.ofSeconds(300), null);
    }

    /**
     * The restoration token returned by {@link #startSessionReadCache}, capturing the prior
     * per-execution cache state so {@link #stopSessionReadCache} can restore it.
     */
    public static final class ReadCacheToken {
        private final Map<SessionCacheKey, Session> previous;
        private final long openingThreadId;

        private ReadCacheToken(Map<SessionCacheKey, Session> previous, long openingThreadId) {
            this.previous = previous;
            this.openingThreadId = openingThreadId;
        }
    }

}
