package com.agui.adk.translator;

import com.agui.adk.translator.step.*;

import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * A factory responsible for creating and configuring a new, stateful
 * {@link EventTranslator} for each agent run. Implemented as a robust JVM singleton.
 */
public enum EventTranslatorFactory {
    INSTANCE; // The single instance of this singleton factory

    private final List<EventTranslationStep> eventTranslationSteps;

    /**
     * Initializes the fixed imported translation pipeline.
     */
    private EventTranslatorFactory() {
        // Manually build the fixed, ordered, and simplified pipeline of steps.
        this.eventTranslationSteps = List.of(
            AdkErrorTranslationStep.INSTANCE,
            ReasoningTranslationStep.INSTANCE,
            TextTranslationStep.INSTANCE,
            ToolCallTranslationStep.INSTANCE,
            ToolResultTranslationStep.INSTANCE,
            StateTranslationStep.INSTANCE,
            AdkMetadataTranslationStep.INSTANCE
        ).stream().map(EventTranslatorFactory::skipUserAuthoredEvents).toList();
    }

    /**
     * Creates a new EventTranslator instance for a specific agent run.
     *
     * @param threadId The ID of the conversation thread for this run.
     * @param runId The unique ID for this specific run.
     * @param predictStateConfig The configuration for predictive state.
     * @return A new, configured EventTranslator instance.
     */
    public EventTranslator create(String threadId, String runId, List<PredictStateMapping> predictStateConfig) {
        return create(threadId, runId, predictStateConfig, Set.of());
    }

    /**
     * Creates a translator configured with predictive-state mappings and output_schema agents.
     *
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     * @param predictStateConfig predictive-state mappings
     * @param outputSchemaAgentNames agent names whose text is suppressed (GitHub #1390)
     * @return configured event translator
     */
    public EventTranslator create(String threadId, String runId, List<PredictStateMapping> predictStateConfig,
                                  Set<String> outputSchemaAgentNames) {
        return create(threadId, runId, predictStateConfig, outputSchemaAgentNames, true);
    }

    /**
     * Creates a translator without predictive state configuration.
     *
     * @param threadId conversation thread identifier
     * @param runId run identifier
     * @return configured event translator
     */
    public EventTranslator create(String threadId, String runId) {
        return create(threadId, runId, List.of());
    }
    /**
     * Creates a translator with an explicit progressive function-call argument setting.
     *
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     * @param predictStateConfig predictive-state mappings
     * @param outputSchemaAgentNames agent names whose text is suppressed
     * @param enableStreamingFcArgs whether partial Gemini function-call arguments emit deltas
     * @return configured event translator
     */
    public EventTranslator create(String threadId, String runId, List<PredictStateMapping> predictStateConfig,
                                  Set<String> outputSchemaAgentNames, boolean enableStreamingFcArgs) {
        TranslationContext context =
                new TranslationContext(threadId, runId, predictStateConfig, outputSchemaAgentNames);
        if (enableStreamingFcArgs) {
            context.enableStreamingFcArgs();
        }
        return new EventTranslator(context, this.eventTranslationSteps);
    }

    /**
     * Wraps one step so user-authored ADK events are dropped before it can inspect them.
     *
     * @param step translation step to guard
     * @return guarded translation step
     */
    private static EventTranslationStep skipUserAuthoredEvents(EventTranslationStep step) {
        return (event, context) -> "user".equals(event.author())
                ? io.reactivex.rxjava3.core.Flowable.empty()
                : step.translate(event, context);
    }

}
