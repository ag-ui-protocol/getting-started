package com.agui.adk.translator;

import java.util.Set;

/**
 * Seam for creating a per-run {@link EventTranslator} on the public run path.
 *
 * <p>Unlike the fixed two-argument {@link java.util.function.BiFunction} it replaces, this
 * contract also receives the output_schema agent names discovered from the effective agent tree,
 * so the run path can hand the translator the authors whose text must be suppressed from the chat
 * UI (GitHub #1390, audit finding M-01).
 */
@FunctionalInterface
public interface EventTranslatorFactoryFn {

    /**
     * Creates a translator for one AG-UI run.
     *
     * @param threadId AG-UI thread identifier
     * @param runId AG-UI run identifier
     * @param outputSchemaAgentNames agent names whose text is suppressed (may be empty)
     * @return configured event translator
     */
    EventTranslator create(String threadId, String runId, Set<String> outputSchemaAgentNames);
}
