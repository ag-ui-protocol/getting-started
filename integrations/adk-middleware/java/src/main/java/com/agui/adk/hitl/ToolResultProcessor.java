package com.agui.adk.hitl;

import com.agui.community.core.message.ToolMessage;
import io.reactivex.rxjava3.core.Single;

import java.util.Objects;

/** Normalizes browser submissions before sending them through the shared atomic claim boundary. */
public final class ToolResultProcessor {
    private final PendingCallStore store;
    private final ToolResultNormalizer normalizer;

    /**
     * Creates a processor using the explicit persistence and normalization seams.
     *
     * @param store shared pending-call store
     * @param normalizer lossless payload normalizer
     */
    public ToolResultProcessor(PendingCallStore store, ToolResultNormalizer normalizer) {
        this.store = Objects.requireNonNull(store, "store");
        this.normalizer = Objects.requireNonNull(normalizer, "normalizer");
    }

    /**
     * Normalizes before atomically accepting the browser result into its session scope.
     *
     * @param scope principal-scoped ADK session
     * @param message official frontend result
     * @return buffered, duplicate, or exclusive ready claim
     */
    public Single<PendingResultTransition> submit(PendingCallScope scope, ToolMessage message) {
        return store.submitResult(scope, ConsumedToolResult.from(message, normalizer));
    }
}
