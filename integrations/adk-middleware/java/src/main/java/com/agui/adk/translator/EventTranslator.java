package com.agui.adk.translator;

import com.agui.adk.hitl.PendingCallScope;
import com.agui.adk.hitl.PendingToolCallEmitter;
import com.agui.adk.translator.step.EventTranslationStep;
import com.agui.adk.translator.step.ToolCallTranslationStep;
import com.google.adk.events.Event;
import io.reactivex.rxjava3.annotations.NonNull;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.FlowableTransformer;
import org.reactivestreams.Publisher;

import java.util.List;
import java.util.Map;

/**
 * A stateful transformer, created once per agent run, that translates a stream of ADK Events
 * into a full, compliant stream of AG-UI BaseEvents, including start, finish, and deferred events.
 * This class acts as the Composite root and a reactive operator.
 */
public class EventTranslator implements FlowableTransformer<Event, com.agui.community.core.event.Event> {

    private final TranslationContext context;
    private final List<EventTranslationStep> eventTranslationSteps;
    private boolean emitProjectedFinalState = true;

    /**
     * A public constructor to be called by the {@link EventTranslatorFactory}.
     * @param context The stateful context for this specific run.
     * @param eventTranslationSteps The ordered list of translation steps for the composite.
     */
    public EventTranslator(TranslationContext context, List<EventTranslationStep> eventTranslationSteps) {
        this.context = context;
        this.eventTranslationSteps = eventTranslationSteps;
    }

    /**
     * The main entry point from the reactive stream, applying the full translation lifecycle.
     * @param upstream The upstream flow of ADK Events.
     * @return The downstream flow of translated AG-UI BaseEvents.
     */
    @Override
    @NonNull
    public Publisher<com.agui.community.core.event.Event> apply(@NonNull Flowable<Event> upstream) {
        Flowable<com.agui.community.core.event.Event> mainTranslationStream = upstream
                .concatMap(this::translate);

        Flowable<com.agui.community.core.event.Event> flushPartialTools = Flowable.defer(() ->
                context.isTerminal() ? Flowable.empty() : ToolCallTranslationStep.INSTANCE.flush(context));
        Flowable<com.agui.community.core.event.Event> closeOpenReasoning = Flowable.defer(() ->
                context.isTerminal() ? Flowable.empty()
                        : com.agui.adk.translator.step.ReasoningTranslationStep.closeReasoning(context));
        Flowable<com.agui.community.core.event.Event> closeOpenText = Flowable.defer(() ->
                context.isTerminal() ? Flowable.empty() : context.forceCloseStreamingMessage()
                        .<com.agui.community.core.event.Event>map(com.agui.community.core.event.TextMessageEndEvent::new)
                        .map(Flowable::just)
                        .orElse(Flowable.empty()));
        Flowable<com.agui.community.core.event.Event> standaloneTerminalTail = Flowable.defer(() -> {
            if (!emitProjectedFinalState) {
                return Flowable.empty();
            }
            Map<String, Object> snapshot = context.stateSnapshot();
            Flowable<com.agui.community.core.event.Event> state = context.isTerminal() || snapshot.isEmpty()
                    ? Flowable.empty()
                    : Flowable.just(new com.agui.community.core.event.StateSnapshotEvent(snapshot));
            return terminalTail(state, Flowable.empty());
        });

        // Upstream completion or failure must not leave a protocol stream open. The owning agent
        // supplies the authoritative state/messages/deferred terminal tail when projection is deferred.
        return mainTranslationStream.concatWith(closeOpenReasoning).concatWith(closeOpenText).concatWith(flushPartialTools)
                .concatWith(standaloneTerminalTail)
                .onErrorResumeNext(error -> closeOpenReasoning.concatWith(closeOpenText).concatWith(Flowable.error(error)));
    }

    /**
     * Translates a single event by delegating to the child steps.
     * @param event The ADK Event to translate.
     * @return A Flowable of generated BaseEvents.
     */
    public Flowable<com.agui.community.core.event.Event> translate(Event event) {
        // The terminal boundary rejects all post-terminal provider state changes.
        if (context.isTerminal()) {
            return Flowable.empty();
        }
        // Set long-running tool IDs from the accepted ADK event to the context.
        event.longRunningToolIds().ifPresent(this.context::populateLongRunningToolIds);

        // This is the composite pattern logic. It uses its own internal context.
        return Flowable.fromIterable(eventTranslationSteps)
                .concatMap(child -> child.translate(event, this.context))
                .concatMap(this::closeLifecyclesBeforeTerminal)
                .takeUntil(translated -> translated instanceof com.agui.community.core.event.RunErrorEvent);
    }

    /**
     * Marks every translated terminal error and closes open visible lifecycles before exposing it.
     *
     * @param translated protocol event produced by one translation step
     * @return the event, preceded by any required text and reasoning lifecycle closure
     */
    private Flowable<com.agui.community.core.event.Event> closeLifecyclesBeforeTerminal(
            com.agui.community.core.event.Event translated) {
        if (!(translated instanceof com.agui.community.core.event.RunErrorEvent)) {
            return Flowable.just(translated);
        }
        context.markTerminal();
        Flowable<com.agui.community.core.event.Event> closeText = context.forceCloseStreamingMessage()
                .<com.agui.community.core.event.Event>map(com.agui.community.core.event.TextMessageEndEvent::new)
                .map(Flowable::just).orElse(Flowable.empty());
        return closeText.concatWith(com.agui.adk.translator.step.ReasoningTranslationStep.closeReasoning(context))
                .concatWith(Flowable.just(translated));
    }

    /**
     * Translates only the text content of one ADK event, ignoring any function calls (Python
     * {@code EventTranslator.translate_text_only}). Used by the run-loop to emit text before
     * long-running tool-call events of the same ADK event.
     *
     * @param event ADK event containing text content
     * @return TEXT_MESSAGE_START / CONTENT / END events for the text parts only
     */
    public Flowable<com.agui.community.core.event.Event> translateTextOnly(Event event) {
        return com.agui.adk.translator.step.TextTranslationStep.INSTANCE
                .translate(event, this.context);
    }

    /**
     * Translates only the long-running function calls of one ADK event (Python
     * {@code EventTranslator.translate_lro_function_calls}); regular calls in the same event are
     * ignored and the positional replay guards still apply.
     *
     * @param event ADK event carrying function-call parts
     * @return TOOL_CALL_START / ARGS / END events for the long-running calls only
     */
    public Flowable<com.agui.community.core.event.Event> translateLroFunctionCalls(Event event) {
        event.longRunningToolIds().ifPresent(this.context::populateLongRunningToolIds);
        return ToolCallTranslationStep.INSTANCE.translateLroFunctionCalls(event, this.context);
    }

    /**
     * Force-closes any open streaming text message with its end event (Python
     * {@code EventTranslator.force_close_streaming_message}). Should be called before ending a
     * run to guarantee proper message termination.
     *
     * @return one TEXT_MESSAGE_END event when a streaming message is open, otherwise empty
     */
    public Flowable<com.agui.community.core.event.Event> forceCloseStreamingMessage() {
        return this.context.forceCloseStreamingMessage()
                .<com.agui.community.core.event.Event>map(com.agui.community.core.event.TextMessageEndEvent::new)
                .map(Flowable::just)
                .orElse(Flowable.empty());
    }

    /**
     * Translates one LRO-bearing event through the Python text-first dedicated path.
     *
     * @param event LRO-bearing provider event
     * @return ordered text, forced close and LRO call events
     */
    public Flowable<com.agui.community.core.event.Event> translateLongRunningEvent(Event event) {
        return translateTextOnly(event)
                .concatWith(forceCloseStreamingMessage())
                .concatWith(translateLroFunctionCalls(event));
    }

    /**
     * Captures the final persisted identifiers for LRO calls emitted from partial events.
     *
     * @param event persisted provider event
     */
    public void capturePersistedLroIds(Event event) {
        context.capturePersistedLroIds(event);
    }

    /**
     * Returns and clears captured client-facing to persisted LRO identifiers.
     *
     * @return captured identifier remap
     */
    public Map<String, String> drainLroIdRemap() {
        return context.drainLroIdRemap();
    }

    /**
     * Resets all translation state so this translator can be reused for a new run (Python
     * {@code EventTranslator.reset}): streaming, tool calls, long-running ids, predictive-state
     * and confirm emission, signatures, deferred confirms and reasoning state are cleared.
     */
    public void reset() {
        this.context.reset();
    }

    /**
     * Seeds the accumulated session state this run starts from, so the end-of-run
     * {@code STATE_SNAPSHOT} reflects the whole session state with this run's deltas applied on
     * top (Python {@code SessionManager.get_session_state}). Must be called before subscription.
     *
     * @param sessionState accumulated ADK session state, may be null or empty
     */
    public void seedSessionState(java.util.Map<String, Object> sessionState) {
        context.seedSessionState(sessionState);
    }

    /**
     * Defers final snapshot emission to the owning agent, which can perform an asynchronous
     * authoritative session-service read after the ADK stream completes.
     */
    public void deferFinalStateSnapshot() {
        emitProjectedFinalState = false;
    }

    /**
     * Emits the Python terminal tail: state, optional messages, deferred confirmations, then the
     * same state again when confirmations were emitted to preserve the HITL rendering gap.
     *
     * @param stateSnapshot materialized zero-or-one final state event
     * @param messagesSnapshot optional messages snapshot stream
     * @return ordered terminal events
     */
    public Flowable<com.agui.community.core.event.Event> terminalTail(
            Flowable<com.agui.community.core.event.Event> stateSnapshot,
            Flowable<com.agui.community.core.event.Event> messagesSnapshot) {
        return Flowable.defer(() -> {
            List<com.agui.community.core.event.Event> deferred = getAndClearDeferredConfirmEvents();
            Flowable<com.agui.community.core.event.Event> confirmations = Flowable.fromIterable(deferred);
            Flowable<com.agui.community.core.event.Event> repeatedState = deferred.isEmpty()
                    ? Flowable.empty() : stateSnapshot;
            return stateSnapshot.concatWith(messagesSnapshot).concatWith(confirmations).concatWith(repeatedState);
        });
    }

    /**
     * Builds the final client snapshot from authoritative post-run session state with accumulated
     * predictive state applied on top.
     *
     * @param authoritativeState freshly read session state
     * @return zero or one snapshot event
     */
    public Flowable<com.agui.community.core.event.Event> finalStateSnapshot(
            java.util.Map<String, Object> authoritativeState) {
        Map<String, Object> snapshot = context.finalStateSnapshot(authoritativeState);
        return context.isTerminal() || snapshot.isEmpty()
                ? Flowable.empty()
                : Flowable.just(new com.agui.community.core.event.StateSnapshotEvent(snapshot));
    }

    /**
     * Configures persisted frontend-call handling for this single invocation.
     *
     * @param scope pending-call storage scope
     * @param invocationId current invocation identifier
     * @param frontendToolNames names of client-executed tools
     * @param emitter persistence-before-visibility event emitter
     */
    public void configureFrontendToolPersistence(
            PendingCallScope scope,
            String invocationId,
            java.util.Set<String> frontendToolNames,
            PendingToolCallEmitter emitter) {
        context.configureFrontendToolPersistence(scope, invocationId, frontendToolNames, emitter);
    }

    /**
     * Retrieves and clears any events that were deferred during the run.
     * @return A list of deferred events.
     */
    public List<com.agui.community.core.event.Event> getAndClearDeferredConfirmEvents() {
        return this.context.getAndClearDeferredConfirmEvents();
    }

    /**
     * Whether any confirm events are currently deferred (Python
     * {@code EventTranslator.has_deferred_confirm_events}).
     *
     * @return true when deferred confirm events exist
     */
    public boolean hasDeferredConfirmEvents() {
        return this.context.hasDeferredConfirmEvents();
    }
}
