package com.agui.adk.hitl;

import com.agui.community.core.interrupt.Interrupt;
import com.agui.community.core.interrupt.Resume;
import com.agui.community.core.interrupt.ResumeStatus;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/** Process-local interruption store with atomic, principal-scoped group admission. */
public final class SessionInterruptStore implements InterruptStore {
    /** Internal implementation detail. */
    private static final Duration DEFAULT_TOMBSTONE_TTL = Duration.ofHours(24);
    /** Internal implementation detail. */
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Internal implementation detail. */
    private final ConcurrentMap<PendingCallScope, ScopeState> states = new ConcurrentHashMap<>();
    /** Internal implementation detail. */
    private final ConcurrentMap<String, PendingCallScope> interruptOwners = new ConcurrentHashMap<>();
    private final Clock clock;
    private final Duration tombstoneTtl;

    /** Creates a store using the system clock and a 24-hour idempotency window. */
    public SessionInterruptStore() {
        this(Clock.systemUTC(), DEFAULT_TOMBSTONE_TTL);
    }

    /**
     * Creates a store with explicit time and tombstone retention controls.
     * @param clock time source
     * @param tombstoneTtl retained idempotency duration
     */
    public SessionInterruptStore(Clock clock, Duration tombstoneTtl) {
        this.clock = Objects.requireNonNull(clock, "clock");
        this.tombstoneTtl = Objects.requireNonNull(tombstoneTtl, "tombstoneTtl");
        if (tombstoneTtl.isNegative() || tombstoneTtl.isZero()) {
            throw new IllegalArgumentException("tombstoneTtl must be positive");
        }
    }

    @Override
    public Completable persistGroup(List<PendingInterrupt> interrupts) {
        return Completable.fromAction(() -> persistGroupNow(List.copyOf(interrupts)));
    }

    /**
     * @param interrupts complete group
     */
    private void persistGroupNow(List<PendingInterrupt> interrupts) {
        if (interrupts.isEmpty()) {
            throw new IllegalArgumentException("interrupt group must not be empty");
        }
        PendingCallGroupKey group = interrupts.getFirst().group();
        if (interrupts.stream().anyMatch(interrupt -> !group.equals(interrupt.group()))) {
            throw new IllegalArgumentException("interrupts must belong to one group");
        }
        Set<String> ids = new HashSet<>();
        if (interrupts.stream().anyMatch(interrupt -> !ids.add(interrupt.interruptId()))) {
            throw new IllegalArgumentException("interrupt ids must be unique");
        }

        ScopeState state = states.computeIfAbsent(group.scope(), ignored -> new ScopeState());
        synchronized (state) {
            compactLocked(group.scope(), state, clock.instant());
            List<String> newlyOwned = new ArrayList<>();
            try {
                for (PendingInterrupt interrupt : interrupts) {
                    PendingCallScope owner = interruptOwners.putIfAbsent(
                            interrupt.interruptId(), group.scope());
                    if (owner == null) {
                        newlyOwned.add(interrupt.interruptId());
                    } else if (!owner.equals(group.scope())) {
                        throw new IllegalStateException("conflicting opaque interrupt id");
                    }
                    PendingInterrupt existing = state.interrupts.get(interrupt.interruptId());
                    Tombstone tombstone = state.tombstones.get(interrupt.interruptId());
                    if ((existing != null && !existing.equals(interrupt)) || tombstone != null) {
                        throw new IllegalStateException(
                                "conflicting immutable interrupt " + interrupt.interruptId());
                    }
                }
                for (PendingInterrupt interrupt : interrupts) {
                    state.interrupts.putIfAbsent(interrupt.interruptId(), interrupt);
                }
            } catch (RuntimeException exception) {
                newlyOwned.forEach(id -> interruptOwners.remove(id, group.scope()));
                throw exception;
            }
        }
    }

    @Override
    public Completable removeGroup(PendingCallGroupKey group, Set<String> interruptIds) {
        return Completable.fromAction(() -> {
            ScopeState state = states.get(group.scope());
            if (state == null) {
                return;
            }
            synchronized (state) {
                for (String id : interruptIds) {
                    PendingInterrupt interrupt = state.interrupts.get(id);
                    if (interrupt != null && group.equals(interrupt.group())) {
                        state.interrupts.remove(id);
                        state.accepted.remove(id);
                        interruptOwners.remove(id, group.scope());
                    }
                }
            }
        });
    }

    @Override
    public Flowable<PendingInterrupt> outstanding(PendingCallScope scope) {
        return Flowable.defer(() -> {
            ScopeState state = states.get(scope);
            if (state == null) {
                return Flowable.empty();
            }
            List<PendingInterrupt> snapshot;
            synchronized (state) {
                compactLocked(scope, state, clock.instant());
                snapshot = state.interrupts.values().stream()
                        .filter(interrupt -> !state.accepted.containsKey(interrupt.interruptId()))
                        .toList();
            }
            return Flowable.fromIterable(snapshot);
        });
    }

    @Override
    public Single<List<PendingInterrupt>> lookup(PendingCallScope scope, List<String> interruptIds) {
        return Single.fromCallable(() -> {
            ScopeState state = states.get(scope);
            if (state == null) {
                throw unknownInterrupt();
            }
            synchronized (state) {
                compactLocked(scope, state, clock.instant());
                List<PendingInterrupt> result = new ArrayList<>();
                for (String interruptId : interruptIds) {
                    PendingInterrupt interrupt = state.interrupts.get(interruptId);
                    if (interrupt == null) {
                        throw unknownInterrupt();
                    }
                    result.add(interrupt);
                }
                return List.copyOf(result);
            }
        });
    }

    @Override
    public Single<InterruptSubmission> submit(PendingCallScope scope, List<Resume> resumes) {
        return Single.fromCallable(() -> submitNow(scope, List.copyOf(resumes)));
    }

    /**
     * @param scope trusted scope
     * @param resumes decisions
     * @return result
     */
    private InterruptSubmission submitNow(PendingCallScope scope, List<Resume> resumes) {
        if (resumes.isEmpty()) {
            throw new IllegalArgumentException("resumes must not be empty");
        }
        Set<String> requestIds = new HashSet<>();
        if (resumes.stream().anyMatch(resume -> !requestIds.add(resume.interruptId()))) {
            throw new IllegalArgumentException("resume interrupt ids must be unique");
        }
        ScopeState state = states.get(scope);
        if (state == null) {
            throw unknownInterrupt();
        }
        synchronized (state) {
            Instant now = clock.instant();
            compactLocked(scope, state, now);
            return submitLocked(state, resumes, now);
        }
    }

    /**
     * @param state scope state
     * @param resumes decisions
     * @param now current time
     * @return result
     */
    private static InterruptSubmission submitLocked(
            ScopeState state, List<Resume> resumes, Instant now) {
        PendingCallGroupKey group = null;
        List<AcceptedResume> decisions = new ArrayList<>();
        boolean allTombstones = true;
        for (Resume resume : resumes) {
            validateResume(resume);
            PendingInterrupt interrupt = state.interrupts.get(resume.interruptId());
            Tombstone tombstone = state.tombstones.get(resume.interruptId());
            if (interrupt == null && tombstone == null) {
                throw unknownInterrupt();
            }
            PendingCallGroupKey candidate = interrupt != null ? interrupt.group() : tombstone.group();
            if (group != null && !group.equals(candidate)) {
                throw new IllegalArgumentException("resumes must belong to one interrupt group");
            }
            group = candidate;
            AcceptedResume decision = accepted(resume, now);
            AcceptedResume existing = interrupt != null
                    ? state.accepted.get(resume.interruptId())
                    : tombstone.resume();
            if (existing != null && !sameDecision(existing, decision)) {
                throw new IllegalArgumentException("conflicting duplicate resume");
            }
            decisions.add(decision);
            allTombstones &= tombstone != null;
        }
        if (allTombstones) {
            return new InterruptSubmission.Duplicate();
        }
        for (Tombstone tombstone : state.tombstones.values()) {
            if (tombstone.group().equals(group)) {
                throw unknownInterrupt();
            }
        }

        List<PendingInterrupt> groupInterrupts = groupInterrupts(state, group);
        if (groupInterrupts.isEmpty()) {
            throw unknownInterrupt();
        }
        if (decisions.stream().anyMatch(decision -> decision.status() == ResumeStatus.CANCELLED)) {
            return cancelGroup(state, group, groupInterrupts, now);
        }
        for (AcceptedResume decision : decisions) {
            state.accepted.putIfAbsent(decision.interruptId(), decision);
        }
        List<Interrupt> outstanding = groupInterrupts.stream()
                .filter(interrupt -> !state.accepted.containsKey(interrupt.interruptId()))
                .map(PendingInterrupt::interrupt)
                .toList();
        if (!outstanding.isEmpty()) {
            return new InterruptSubmission.Pending(outstanding);
        }
        InterruptGroupClaim active = state.claims.get(group);
        if (active != null) {
            return new InterruptSubmission.Duplicate();
        }
        InterruptGroupClaim claim = claim(group, groupInterrupts, state.accepted);
        state.claims.put(group, claim);
        return new InterruptSubmission.Claimed(claim);
    }

    /**
     * @param state scope state
     * @param group group
     * @param interrupts siblings
     * @param now current time
     * @return result
     */
    private static InterruptSubmission cancelGroup(
            ScopeState state,
            PendingCallGroupKey group,
            List<PendingInterrupt> interrupts,
            Instant now) {
        List<Interrupt> cancelled = interrupts.stream().map(PendingInterrupt::interrupt).toList();
        for (PendingInterrupt interrupt : interrupts) {
            AcceptedResume accepted = state.accepted.get(interrupt.interruptId());
            if (accepted == null) {
                Resume cancelledResume =
                        new Resume(interrupt.interruptId(), ResumeStatus.CANCELLED, null);
                accepted = accepted(cancelledResume, now);
            }
            state.tombstones.put(interrupt.interruptId(), new Tombstone(group, accepted, now));
            state.interrupts.remove(interrupt.interruptId());
            state.accepted.remove(interrupt.interruptId());
        }
        state.claims.remove(group);
        state.finalizationPending.remove(group);
        return new InterruptSubmission.Cancelled(cancelled);
    }

    @Override
    public Completable release(InterruptGroupClaim claim) {
        return Completable.fromAction(() -> withActiveClaim(claim, state -> {
            if (state.finalizationPending.contains(claim.group())) {
                throw new IllegalStateException("finalization-pending claim cannot be released");
            }
            state.claims.remove(claim.group());
        }));
    }

    @Override
    public Completable markFinalizationPending(InterruptGroupClaim claim) {
        return Completable.fromAction(() -> withActiveClaim(
                claim, state -> state.finalizationPending.add(claim.group())));
    }

    @Override
    public Single<Boolean> finalizationPending(InterruptGroupClaim claim) {
        return Single.fromCallable(() -> {
            ScopeState state = states.get(claim.group().scope());
            if (state == null) {
                throw new IllegalStateException("interrupt claim scope is absent");
            }
            synchronized (state) {
                requireActiveClaim(state, claim);
                return state.finalizationPending.contains(claim.group());
            }
        });
    }

    @Override
    public Completable releaseFinalization(InterruptGroupClaim claim) {
        return Completable.fromAction(() -> withActiveClaim(claim, state -> {
            if (!state.finalizationPending.contains(claim.group())) {
                throw new IllegalStateException("interrupt finalization is not pending");
            }
            state.claims.remove(claim.group());
        }));
    }

    @Override
    public Completable complete(InterruptGroupClaim claim) {
        return Completable.fromAction(() -> withActiveClaim(claim, state -> {
            Instant now = clock.instant();
            for (int index = 0; index < claim.interrupts().size(); index++) {
                PendingInterrupt interrupt = claim.interrupts().get(index);
                AcceptedResume resume = claim.resumes().get(index);
                state.tombstones.put(
                        interrupt.interruptId(), new Tombstone(claim.group(), resume, now));
                state.interrupts.remove(interrupt.interruptId());
                state.accepted.remove(interrupt.interruptId());
            }
            state.finalizationPending.remove(claim.group());
            state.claims.remove(claim.group());
        }));
    }

    /**
     * Removes expired idempotency tombstones.
     * @return removed tombstone count
     */
    public int compact() {
        Instant now = clock.instant();
        int removed = 0;
        for (Map.Entry<PendingCallScope, ScopeState> entry : states.entrySet()) {
            ScopeState state = entry.getValue();
            synchronized (state) {
                removed += compactLocked(entry.getKey(), state, now);
            }
        }
        return removed;
    }

    /**
     * @param scope trusted scope
     * @param state scope state
     * @param now current time
     * @return result
     */
    private int compactLocked(PendingCallScope scope, ScopeState state, Instant now) {
        List<String> expired = state.tombstones.entrySet().stream()
                .filter(entry -> !entry.getValue().completedAt().plus(tombstoneTtl).isAfter(now))
                .map(Map.Entry::getKey)
                .toList();
        expired.forEach(id -> {
            state.tombstones.remove(id);
            interruptOwners.remove(id, scope);
        });
        return expired.size();
    }

    /**
     * @param claim active claim
     * @param action mutation
     */
    private void withActiveClaim(InterruptGroupClaim claim, StateAction action) {
        ScopeState state = states.get(claim.group().scope());
        if (state == null) {
            throw new IllegalStateException("interrupt claim scope is absent");
        }
        synchronized (state) {
            requireActiveClaim(state, claim);
            action.apply(state);
        }
    }

    /**
     * @param state scope state
     * @param claim claim handle
     */
    private static void requireActiveClaim(ScopeState state, InterruptGroupClaim claim) {
        if (!claim.equals(state.claims.get(claim.group()))) {
            throw new IllegalStateException("interrupt claim is not active");
        }
    }

    /**
     * @param group group
     * @param interrupts siblings
     * @param accepted decisions
     * @return result
     */
    private static InterruptGroupClaim claim(
            PendingCallGroupKey group,
            List<PendingInterrupt> interrupts,
            Map<String, AcceptedResume> accepted) {
        List<AcceptedResume> resumes = interrupts.stream()
                .map(interrupt -> accepted.get(interrupt.interruptId()))
                .toList();
        return new InterruptGroupClaim(group, interrupts, resumes);
    }

    /**
     * @param state scope state
     * @param group group
     * @return result
     */
    private static List<PendingInterrupt> groupInterrupts(
            ScopeState state, PendingCallGroupKey group) {
        return state.interrupts.values().stream()
                .filter(interrupt -> interrupt.group().equals(group))
                .toList();
    }

    /**
     * @param resume official response
     */
    private static void validateResume(Resume resume) {
        Objects.requireNonNull(resume, "resume");
        if (resume.interruptId().isBlank()) {
            throw new IllegalArgumentException("interruptId must not be blank");
        }
        if (resume.status() == ResumeStatus.CANCELLED && resume.payload() != null) {
            throw new IllegalArgumentException("cancelled resume payload must be null");
        }
    }

    /**
     * @param resume official response
     * @param now current time
     * @return result
     */
    private static AcceptedResume accepted(Resume resume, Instant now) {
        return new AcceptedResume(
                resume.interruptId(),
                resume.status(),
                resume.payload(),
                fingerprint(resume.status(), resume.payload()),
                now);
    }

    /**
     * @param left accepted response
     * @param right candidate response
     * @return result
     */
    private static boolean sameDecision(AcceptedResume left, AcceptedResume right) {
        return left.status() == right.status() && left.fingerprint().equals(right.fingerprint());
    }

    /**
     * @param status resume status
     * @param payload JSON payload
     * @return result
     */
    private static String fingerprint(ResumeStatus status, Object payload) {
        String canonical = status.value() + ':' + canonicalJson(MAPPER.valueToTree(payload));
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    /**
     * @param node JSON value
     * @return result
     */
    private static String canonicalJson(JsonNode node) {
        if (node.isObject()) {
            Map<String, String> fields = new TreeMap<>();
            node.fields().forEachRemaining(entry -> fields.put(entry.getKey(), canonicalJson(entry.getValue())));
            return fields.entrySet().stream()
                    .map(entry -> quote(entry.getKey()) + ':' + entry.getValue())
                    .collect(java.util.stream.Collectors.joining(",", "{", "}"));
        }
        if (node.isArray()) {
            List<String> elements = new ArrayList<>();
            node.elements().forEachRemaining(element -> elements.add(canonicalJson(element)));
            return String.join(",", elements).transform(value -> '[' + value + ']');
        }
        if (node.isNumber()) {
            java.math.BigDecimal number = node.decimalValue().stripTrailingZeros();
            return number.signum() == 0 ? "0" : number.toPlainString();
        }
        return node.toString();
    }

    /**
     * @param value object key
     * @return result
     */
    private static String quote(String value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("payload cannot be canonicalized", exception);
        }
    }

    /**
     * @return result
     */
    private static IllegalArgumentException unknownInterrupt() {
        return new IllegalArgumentException("unknown interrupt");
    }

    /** Mutation performed under one scope monitor. */
    @FunctionalInterface
    /** Internal implementation detail. */
    private interface StateAction {
        void apply(ScopeState state);
    }

    /** Bounded terminal response identity. */
    private record Tombstone(
            PendingCallGroupKey group, AcceptedResume resume, Instant completedAt) {}

    /** Mutable state guarded by its instance monitor. */
    private static final class ScopeState {
    /** Internal implementation detail. */
        private final Map<String, PendingInterrupt> interrupts = new LinkedHashMap<>();
    /** Internal implementation detail. */
        private final Map<String, AcceptedResume> accepted = new LinkedHashMap<>();
    /** Internal implementation detail. */
        private final Map<String, Tombstone> tombstones = new LinkedHashMap<>();
    /** Internal implementation detail. */
        private final Map<PendingCallGroupKey, InterruptGroupClaim> claims = new LinkedHashMap<>();
    /** Internal implementation detail. */
        private final Set<PendingCallGroupKey> finalizationPending = new HashSet<>();
    }
}
