package com.agui.adk.hitl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.adk.encoding.CanonicalEventEncoder;
import com.agui.adk.encoding.EncodedEvent;
import com.agui.adk.encoding.PreEncodedEvent;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Persists frontend calls before emission and replays their exact prevalidated wire representation. */
public final class PendingToolCallEmitter {
    private static final String ENCODING_ERROR_CODE = "ENCODING_ERROR";
    private static final String ENCODING_ERROR_MESSAGE = "Event encoding failed";
    private static final ObjectMapper JSON = new ObjectMapper();

    private final PendingCallStore store;
    private final CanonicalEventEncoder encoder;
    private final ToolCallLedger ledger;
    private final InterruptStore interruptStore;
    private final InterruptFactory interruptFactory;
    private final String originRunId;
    private final java.util.Map<String, ToolCallEndEvent> deferredEnds = new java.util.LinkedHashMap<>();

    /**
     * Creates the persist-before-visibility boundary.
     *
     * @param store durable pending-call store
     * @param encoder official-event JSON encoder
     * @param ledger request-local identifier ledger
     */
    public PendingToolCallEmitter(PendingCallStore store, CanonicalEventEncoder encoder, ToolCallLedger ledger) {
        this.store = Objects.requireNonNull(store, "store");
        this.encoder = encoder;
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.interruptStore = null;
        this.interruptFactory = null;
        this.originRunId = null;
    }

    /**
     * Creates a persist-before-visibility boundary that also snapshots official interrupts.
     *
     * @param store durable pending-call store
     * @param encoder official-event JSON encoder
     * @param ledger request-local identifier ledger
     * @param interruptStore durable official interrupt store
     * @param interruptFactory official interrupt snapshot factory
     * @param originRunId public run exposing the interrupts
     */
    public PendingToolCallEmitter(
            PendingCallStore store,
            CanonicalEventEncoder encoder,
            ToolCallLedger ledger,
            InterruptStore interruptStore,
            InterruptFactory interruptFactory,
            String originRunId) {
        this.store = Objects.requireNonNull(store, "store");
        this.encoder = encoder;
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.interruptStore = Objects.requireNonNull(interruptStore, "interruptStore");
        this.interruptFactory = Objects.requireNonNull(interruptFactory, "interruptFactory");
        this.originRunId = Objects.requireNonNull(originRunId, "originRunId");
    }


    /**
     * Retains one native/backend HITL end until its correlation is durably committed.
     *
     * @param event native/backend end event
     */
    public synchronized void deferEnd(ToolCallEndEvent event) {
        Objects.requireNonNull(event, "event");
        deferredEnds.putIfAbsent(event.toolCallId(), event);
    }

    /**
     * Returns the native/backend HITL IDs whose end events are not yet visible.
     *
     * @return deferred correlation identifiers
     */
    public synchronized Set<String> deferredEndIds() {
        return Set.copyOf(deferredEnds.keySet());
    }

    /**
     * Releases retained native/backend ends only after the supplied durable commit completes.
     * A failed commit is terminal and never exposes an end event.
     *
     * @param durableCommit pending-correlation persistence completion
     * @return retained ends after durability, or a persistence error event
     */
    public Flowable<Event> emitDeferredEndsAfter(io.reactivex.rxjava3.core.Completable durableCommit) {
        Objects.requireNonNull(durableCommit, "durableCommit");
        return durableCommit.andThen(Flowable.defer(() -> {
                    List<Event> released;
                    synchronized (this) {
                        released = deferredEnds.values().stream().map(event -> (Event) event).toList();
                        deferredEnds.clear();
                    }
                    return Flowable.fromIterable(released);
                }))
                .onErrorReturn(ignored -> new RunErrorEvent(
                        "Persistence failure", "PERSISTENCE_FAILURE", null, null));
    }

    /**
     * Emits backend calls directly and owns frontend persistence independently of downstream cancellation.
     *
     * @param scope principal-scoped session identity
     * @param invocationId request invocation identity
     * @param position call position within the provider event
     * @param event frontend or backend official event
     * @param frontend whether the call belongs to request-scoped frontend tools
     * @return the visible event or a stable run error
     */
    public Flowable<Event> emit(
            PendingCallScope scope,
            String invocationId,
            int position,
            ToolCallChunkEvent event,
            boolean frontend) {
        Objects.requireNonNull(event, "event");
        if (!frontend) {
            return Flowable.just(event);
        }
        return Flowable.defer(() -> persistThenEmit(scope, invocationId, position, event));
    }

    /**
     * Encodes every sibling before persistence, then persists every encoded call before visibility.
     *
     * <p>If a later sibling cannot encode or persist, this method durably removes only records
     * whose persistence completed in this batch. Persistence and compensation remain part of the
     * subscribed run instead of being retained by a replay cache.
     *
     * @param scope principal-scoped session identity
     * @param invocationId request invocation identity
     * @param calls frontend calls in provider order
     * @return all visible chunks in provider order, or one stable terminal error
     */
    public Flowable<Event> emitAll(
            PendingCallScope scope, String invocationId, List<PositionedToolCall> calls) {
        return Flowable.defer(() -> {
            List<PendingToolCall> prepared = new ArrayList<>();
            try {
                for (PositionedToolCall positioned : calls) {
                    ToolCallChunkEvent event = positioned.event();
                    String id = ledger.idFor(invocationId, positioned.position(), event.toolCallId());
                    ToolCallChunkEvent identified = id.equals(event.toolCallId()) ? event : new ToolCallChunkEvent(
                            id, event.toolCallName(), event.parentMessageId(), event.delta(),
                            event.timestamp(), event.rawEvent());
                    EncodedEvent encoded = encoder.encode(identified);
                    if (!identified.equals(encoded.event())) {
                        throw new IllegalArgumentException("encoder must retain the official event exactly");
                    }
                    validateEncodedEvent(identified, encoded.json());
                    PendingCallKey key = new PendingCallKey(new PendingCallGroupKey(
                            Objects.requireNonNull(scope, "scope"),
                            Objects.requireNonNull(invocationId, "invocationId")), identified.toolCallId());
                    prepared.add(new PendingToolCall(key, identified, encoded.json(), PendingStatus.PENDING));
                }
            } catch (RuntimeException error) {
                return Flowable.just(new RunErrorEvent(ENCODING_ERROR_MESSAGE, ENCODING_ERROR_CODE, null, null));
            }
            List<PendingToolCall> persisted = new ArrayList<>();
            List<PendingInterrupt> interrupts = prepareInterrupts(prepared);
            io.reactivex.rxjava3.core.Completable writes = Flowable.fromIterable(prepared)
                    .concatMapCompletable(call -> store.persist(call).doOnComplete(() -> persisted.add(call)))
                    .andThen(persistInterrupts(interrupts));
            Flowable<Event> settled = writes.andThen(Flowable.fromIterable(prepared)
                            .map(call -> (Event) visibleEvent(call.event(), call.json())))
                    .onErrorResumeNext(ignored -> compensateInterrupts(interrupts)
                            .andThen(compensate(prepared, persisted))
                            .andThen(Flowable.just(new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null))));
            return settled;
        });
    }

    /**
     * Compensates only records whose persistence completed during this provider-event batch.
     *
     * @param prepared all records prepared by the batch
     * @param persisted records durably created before its failure
     * @return owned compensation completion
     */
    private io.reactivex.rxjava3.core.Completable compensate(
            List<PendingToolCall> prepared, List<PendingToolCall> persisted) {
        if (persisted.isEmpty()) {
            return io.reactivex.rxjava3.core.Completable.complete();
        }
        PendingCallGroupKey group = prepared.getFirst().key().group();
        Set<String> ids = persisted.stream().map(call -> call.key().toolCallId()).collect(java.util.stream.Collectors.toSet());
        return io.reactivex.rxjava3.core.Completable.defer(() -> store.remove(group, ids)).onErrorComplete();
    }

    /** Identifies one canonical frontend chunk at its provider-event position. */
    public record PositionedToolCall(int position, ToolCallChunkEvent event) { }

    /**
     * Replays retained records not acknowledged in client history without re-encoding them.
     *
     * @param scope principal-scoped session identity
     * @param knownToolCallIds call IDs already visible to the client
     * @return exact previously validated event JSON and typed records
     */
    public Flowable<EncodedEvent> replay(PendingCallScope scope, Set<String> knownToolCallIds) {
        Set<String> known = knownToolCallIds == null ? Set.of() : Set.copyOf(knownToolCallIds);
        return store.pending(Objects.requireNonNull(scope, "scope"))
                .filter(call -> call.status() == PendingStatus.PENDING)
                .filter(call -> !known.contains(call.key().toolCallId()))
                .map(call -> new EncodedEvent(visibleEvent(call.event(), call.json()), call.json()));
    }

    /**
     * Persists one fully encoded record before making it visible.
     *
     * @param scope principal-scoped session identity
     * @param invocationId request invocation identity
     * @param position provider-call position
     * @param event identified official frontend event
     * @return persisted event or a stable error event
     */
    private Flowable<Event> persistThenEmit(
            PendingCallScope scope, String invocationId, int position, ToolCallChunkEvent event) {
        final ToolCallChunkEvent identified;
        final EncodedEvent encoded;
        try {
            String id = ledger.idFor(invocationId, position, event.toolCallId());
            identified = id.equals(event.toolCallId()) ? event : new ToolCallChunkEvent(
                    id, event.toolCallName(), event.parentMessageId(), event.delta(),
                    event.timestamp(), event.rawEvent());
            encoded = encoder.encode(identified);
            if (!identified.equals(encoded.event())) {
                throw new IllegalArgumentException("encoder must retain the official event exactly");
            }
            validateEncodedEvent(identified, encoded.json());
        } catch (RuntimeException error) {
            return Flowable.just(new RunErrorEvent(ENCODING_ERROR_MESSAGE, ENCODING_ERROR_CODE, null, null));
        }
        final PendingToolCall call;
        final io.reactivex.rxjava3.core.Completable persistence;
        try {
            PendingCallKey key = new PendingCallKey(
                    new PendingCallGroupKey(Objects.requireNonNull(scope, "scope"),
                            Objects.requireNonNull(invocationId, "invocationId")), identified.toolCallId());
            call = new PendingToolCall(key, identified, encoded.json(), PendingStatus.PENDING);
            persistence = store.persist(call);
        } catch (RuntimeException error) {
            return Flowable.just(new RunErrorEvent("Persistence failure", "PERSISTENCE_FAILURE", null, null));
        }
        List<PendingInterrupt> interrupts = prepareInterrupts(List.of(call));
        java.util.concurrent.atomic.AtomicBoolean persisted = new java.util.concurrent.atomic.AtomicBoolean();
        return persistence
                .doOnComplete(() -> persisted.set(true))
                .andThen(persistInterrupts(interrupts))
                .andThen(Flowable.just((Event) visibleEvent(call.event(), call.json())))
                .onErrorResumeNext(ignored -> compensateInterrupts(interrupts)
                        .andThen(compensate(List.of(call), persisted.get() ? List.of(call) : List.of()))
                        .andThen(Flowable.just(new RunErrorEvent(
                                "Persistence failure", "PERSISTENCE_FAILURE", null, null))));
    }

    /**
     * Builds provider-ordered immutable interrupt snapshots for one frontend group.
     * @param calls persisted frontend calls
     * @return provider-ordered interrupt snapshots
     */
    private List<PendingInterrupt> prepareInterrupts(List<PendingToolCall> calls) {
        if (interruptStore == null) {
            return List.of();
        }
        return calls.stream().map(call -> interruptFactory.frontendTool(
                call.key().group(), originRunId, call.key().toolCallId(),
                call.event().toolCallName(), Map.of(
                        "$schema", "https://json-schema.org/draft/2020-12/schema",
                        "oneOf", List.of(
                                Map.of("type", "object"),
                                Map.of("type", "array"),
                                Map.of("type", List.of(
                                        "string", "number", "integer", "boolean", "null")))))).toList();
    }

    /**
     * Persists a complete interrupt group before any corresponding tool event becomes visible.
     * @param interrupts complete interrupt group
     * @return persistence completion
     */
    private io.reactivex.rxjava3.core.Completable persistInterrupts(List<PendingInterrupt> interrupts) {
        return interrupts.isEmpty()
                ? io.reactivex.rxjava3.core.Completable.complete()
                : interruptStore.persistGroup(interrupts);
    }

    /**
     * Removes a newly-created interrupt group during failed dual-store persistence.
     * @param interrupts newly-created snapshots
     * @return compensation completion
     */
    private io.reactivex.rxjava3.core.Completable compensateInterrupts(List<PendingInterrupt> interrupts) {
        if (interrupts.isEmpty()) {
            return io.reactivex.rxjava3.core.Completable.complete();
        }
        return interruptStore.removeGroup(
                        interrupts.getFirst().group(),
                        interrupts.stream().map(PendingInterrupt::interruptId)
                                .collect(java.util.stream.Collectors.toSet()))
                .onErrorComplete();
    }

    /**
     * Attaches exact already-validated JSON to an official event without introducing a new Event subtype.
     *
     * @param event stored official event
     * @param json exact encoded wire representation
     * @return official event carrying the pre-encoded transport representation
     */
    private static ToolCallChunkEvent visibleEvent(ToolCallChunkEvent event, String json) {
        return new ToolCallChunkEvent(event.toolCallId(), event.toolCallName(), event.parentMessageId(), event.delta(),
                event.timestamp(), new PreEncodedEvent(event, json));
    }

    /**
     * Verifies that retained bytes describe the exact official event being persisted.
     *
     * @param event official event
     * @param json candidate wire JSON
     */
    private static void validateEncodedEvent(ToolCallChunkEvent event, String json) {
        try {
            JsonNode root = JSON.readTree(Objects.requireNonNull(json, "json"));
            if (root == null || !root.isObject()
                    || !matchesRequired(root, "type", "TOOL_CALL_CHUNK")
                    || !matchesRequired(root, "toolCallId", event.toolCallId())
                    || !matchesRequired(root, "toolCallName", event.toolCallName())
                    || !matchesRequired(root, "delta", event.delta())
                    || !matchesOptional(root, "parentMessageId", event.parentMessageId())
                    || !matchesOptional(root, "timestamp", event.timestamp())) {
                throw new IllegalArgumentException("encoded JSON does not match tool-call event");
            }
        } catch (Exception error) {
            throw new IllegalArgumentException("encoded JSON does not match tool-call event", error);
        }
    }

    /**
     * Compares a required JSON property with its typed event value.
     *
     * @param root encoded event root
     * @param name JSON property name
     * @param value expected non-null value
     * @return whether the property is present and equal
     */
    private static boolean matchesRequired(JsonNode root, String name, Object value) {
        return value != null && root.has(name) && !root.get(name).isNull()
                && JSON.valueToTree(value).equals(root.get(name));
    }

    /**
     * Compares an optional JSON property with its typed event value.
     *
     * @param root encoded event root
     * @param name JSON property name
     * @param value expected optional value
     * @return whether the property has compatible null or equal value semantics
     */
    private static boolean matchesOptional(JsonNode root, String name, Object value) {
        JsonNode node = root.get(name);
        return value == null ? node == null || node.isNull()
                : node != null && !node.isNull() && JSON.valueToTree(value).equals(node);
    }
}
