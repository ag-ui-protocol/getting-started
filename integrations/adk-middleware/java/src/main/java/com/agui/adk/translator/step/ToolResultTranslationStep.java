package com.agui.adk.translator.step;

import com.google.adk.events.Event;
import com.google.genai.types.FunctionResponse;
import com.agui.adk.serialization.ToolResponseSerializer;
import com.agui.adk.translator.TranslationContext;
import com.agui.community.core.event.ToolCallResultEvent;
import io.reactivex.rxjava3.core.Flowable;

import java.util.List;

/** Emits one canonical backend-tool result with its exact provider call correlation. */
public enum ToolResultTranslationStep implements EventTranslationStep {
    INSTANCE;

    @Override
    public Flowable<com.agui.community.core.event.Event> translate(Event event, TranslationContext context) {
        return Flowable.fromIterable(event.functionResponses())
                .concatMap(response -> emit(response, context));
    }

    /**
     * Emits an unfiltered first server result under the exact provider identifier.
     *
     * @param response provider response
     * @param context translation state
     * @return canonical result event or an empty stream
     */
    private Flowable<com.agui.community.core.event.Event> emit(FunctionResponse response, TranslationContext context) {
        String providerId = response.id().orElse(null);
        String name = response.name().orElse("");
        return Flowable.defer(() -> {
            if (context.deferPartialToolResult(providerId, name, response)) {
                return emitSettledBatches(context.drainSettledPartialToolCallBatches(), context);
            }
            return result(response, context, providerId, name);
        });
    }

    /**
     * Emits every newly settled retained batch and its buffered backend results.
     *
     * @param batches settled original provider-event batches
     * @param context translation state
     * @return ordered canonical lifecycle and result events
     */
    Flowable<com.agui.community.core.event.Event> emitSettledBatches(
            List<TranslationContext.SettledPartialBatch> batches, TranslationContext context) {
        return Flowable.fromIterable(batches).concatMap(batch -> ToolCallTranslationStep.INSTANCE
                .emitReadyCalls(batch.calls(), context).toList().toFlowable().flatMap(events -> containsTerminalError(events)
                        ? Flowable.fromIterable(events)
                        : Flowable.fromIterable(events).concatWith(Flowable.fromIterable(batch.responses())
                                .concatMap(response -> result(response, context, response.id().orElse(null),
                                        response.name().orElse(""))))));
    }

    /**
     * Builds the result only after its partial provider-event batch has settled successfully.
     *
     * @param response provider function response
     * @param context translation state
     * @param providerId provider response identifier, if present
     * @param name provider response tool name
     * @return result event stream
     */
    private Flowable<com.agui.community.core.event.Event> result(
            FunctionResponse response, TranslationContext context, String providerId, String name) {
        return context.resolveToolResultId(providerId, name)
                // Mode-A streaming: the aggregated (confirmed) provider id is remapped to the stable
                // synthetic streaming id the client actually saw in TOOL_CALL_START, so the result
                // correlates with an open call instead of orphaning
                // (Python _translate_function_response `_confirmed_to_streaming_id` remap).
                .map(id -> {
                    String streamingId = context.streamingIdForConfirmed(id);
                    return streamingId == null ? id : streamingId;
                })
                .filter(id -> !context.isFrontendTool(name))
                // Suppress the result for every long-running call, not just AG-UI frontend proxies:
                // a native ADK LongRunningFunctionTool is owned by the frontend for the rest of the
                // turn, so emitting its backend result renders a premature "completed" state
                // (Python `if tool_call_id in self.long_running_tool_ids: continue`).
                .filter(id -> !context.isLongRunningTool(id))
                // Suppress the result for predictive-state backend tools: the frontend already
                // tracks state via the PredictState mechanism, and emitting a result raises
                // "No function call event found" (mirrors the Python _translate_function_response).
                .filter(id -> !context.isPredictiveStateTool(id))
                .filter(context::markToolResultEmitted)
                .<Flowable<com.agui.community.core.event.Event>>map(id -> Flowable.just(new ToolCallResultEvent(
                        java.util.UUID.randomUUID().toString(), id,
                        ToolResponseSerializer.serialize(response.response().orElse(null)))))
                .orElse(Flowable.empty());
    }

    private static boolean containsTerminalError(List<com.agui.community.core.event.Event> events) {
        return events.stream().anyMatch(com.agui.community.core.event.RunErrorEvent.class::isInstance);
    }
}
