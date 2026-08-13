package com.agui.adk.session;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;

import java.util.function.Supplier;

/**
 * Store for AG-UI thread to ADK session mappings.
 *
 * <p>Production generated-ID deployments must provide an implementation whose get-or-create
 * operation is atomic across all bridge instances.
 */
public interface ThreadSessionMappingStore {

    /**
     * Atomically returns an existing mapping or invokes the lazy mapping factory exactly once.
     *
     * @param key AG-UI thread identity
     * @param factory lazy mapping allocator
     * @return stable mapping
     */
    Single<SessionMapping> getOrCreateMapping(
            SessionMappingKey key, Supplier<Single<SessionMapping>> factory);

    /**
     * Reads an existing mapping without allocating or mutating store state.
     *
     * @param key AG-UI thread identity
     * @return existing mapping or an empty signal
     */
    default Maybe<SessionMapping> findMapping(SessionMappingKey key) {
        return Maybe.empty();
    }

    /**
     * Invalidates one mapping after its ADK session has been deleted.
     *
     * @param key AG-UI thread identity
     * @return completion signal
     */
    Completable invalidate(SessionMappingKey key);

    /**
     * Reports whether this store's get-or-create operation is atomic across bridge processes.
     *
     * @return whether generated-ID mappings have distributed atomicity
     */
    boolean isDistributedAtomic();
}
