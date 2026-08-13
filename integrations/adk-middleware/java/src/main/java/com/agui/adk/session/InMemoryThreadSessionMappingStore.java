package com.agui.adk.session;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;

import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/** Process-local atomic implementation of {@link ThreadSessionMappingStore}. */
public final class InMemoryThreadSessionMappingStore implements ThreadSessionMappingStore {

    private final ConcurrentMap<SessionMappingKey, Single<SessionMapping>> mappings =
            new ConcurrentHashMap<>();

    @Override
    public Single<SessionMapping> getOrCreateMapping(
            SessionMappingKey key, Supplier<Single<SessionMapping>> factory) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(factory, "factory");
        return mappings.computeIfAbsent(key, ignored -> cachedMapping(key, factory));
    }

    @Override
    public Maybe<SessionMapping> findMapping(SessionMappingKey key) {
        Objects.requireNonNull(key, "key");
        Single<SessionMapping> mapping = mappings.get(key);
        return mapping == null ? Maybe.empty() : mapping.toMaybe();
    }

    /**
     * Cache a mapping allocation while evicting this exact entry after an error.
     *
     * @param key mapping key
     * @param factory mapping allocator
     * @return cached mapping allocation
     */
    private Single<SessionMapping> cachedMapping(
            SessionMappingKey key, Supplier<Single<SessionMapping>> factory) {
        AtomicReference<Single<SessionMapping>> cachedReference = new AtomicReference<>();
        Single<SessionMapping> cached = Single.defer(factory::get)
                .doOnError(ignored -> mappings.remove(key, cachedReference.get()))
                .cache();
        cachedReference.set(cached);
        return cached;
    }

    @Override
    public Completable invalidate(SessionMappingKey key) {
        Objects.requireNonNull(key, "key");
        return Completable.fromAction(() -> mappings.remove(key));
    }

    @Override
    public boolean isDistributedAtomic() {
        return false;
    }
}
