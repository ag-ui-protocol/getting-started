package com.agui.adk.session;

import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SessionMappingTest {

    @Test
    void sameThreadForDifferentUsersGetsDifferentMappings() {
        ThreadSessionMappingStore store = new InMemoryThreadSessionMappingStore();

        SessionMappingKey aliceKey = new SessionMappingKey("app", "alice", "thread");
        SessionMappingKey bobKey = new SessionMappingKey("app", "bob", "thread");
        SessionMapping first = store.getOrCreateMapping(aliceKey, factory(aliceKey, "session-a")).blockingGet();
        SessionMapping second = store.getOrCreateMapping(bobKey, factory(bobKey, "session-b")).blockingGet();

        assertThat(first.sessionId()).isNotEqualTo(second.sessionId());
    }

    @Test
    void atomicStoreInvokesFactoryOnlyOnceForConcurrentMisses() throws Exception {
        ThreadSessionMappingStore store = new InMemoryThreadSessionMappingStore();
        SessionMappingKey key = new SessionMappingKey("app", "user", "thread");
        AtomicInteger creations = new AtomicInteger();
        ExecutorService executor = Executors.newFixedThreadPool(8);
        CountDownLatch start = new CountDownLatch(1);
        List<String> sessionIds = new ArrayList<>();

        for (int index = 0; index < 20; index++) {
            executor.submit(() -> {
                start.await();
                String sessionId = store.getOrCreateMapping(key,
                        () -> Single.just(new SessionMapping(key, "session-" + creations.incrementAndGet())))
                        .blockingGet().sessionId();
                synchronized (sessionIds) {
                    sessionIds.add(sessionId);
                }
                return null;
            });
        }
        start.countDown();
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();

        assertThat(store.isDistributedAtomic()).isFalse();
        assertThat(creations).hasValue(1);
        assertThat(sessionIds).containsOnly("session-1");
    }

    @Test
    void nonAtomicStoreAllocatesDuplicateMappingsDuringCoordinatedConcurrentMisses() throws Exception {
        ThreadSessionMappingStore store = new DeliberatelyNonAtomicMappingStore();
        SessionMappingKey key = new SessionMappingKey("app", "user", "thread");
        AtomicInteger allocations = new AtomicInteger();
        CountDownLatch bothFactoriesStarted = new CountDownLatch(2);
        ExecutorService executor = Executors.newFixedThreadPool(2);

        List<SessionMapping> mappings = new ArrayList<>();
        for (int index = 0; index < 2; index++) {
            executor.submit(() -> {
                SessionMapping mapping = store.getOrCreateMapping(key, () -> Single.fromCallable(() -> {
                    bothFactoriesStarted.countDown();
                    assertThat(bothFactoriesStarted.await(5, TimeUnit.SECONDS)).isTrue();
                    return new SessionMapping(key, "session-" + allocations.incrementAndGet());
                })).blockingGet();
                synchronized (mappings) {
                    mappings.add(mapping);
                }
                return null;
            });
        }
        executor.shutdown();
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();

        assertThat(store.isDistributedAtomic()).isFalse();
        assertThat(allocations).hasValue(2);
        assertThat(mappings).extracting(SessionMapping::sessionId)
                .containsExactlyInAnyOrder("session-1", "session-2");
    }

    @Test
    void failedAllocationCanBeRetriedAndSuccessfulRetryIsCached() {
        ThreadSessionMappingStore store = new InMemoryThreadSessionMappingStore();
        SessionMappingKey key = new SessionMappingKey("app", "user", "thread");
        AtomicInteger attempts = new AtomicInteger();
        Supplier<Single<SessionMapping>> factory = () -> {
            if (attempts.incrementAndGet() == 1) {
                return Single.error(new IllegalStateException("temporary allocation failure"));
            }
            return Single.just(new SessionMapping(key, "session-" + attempts.get()));
        };

        assertThatThrownBy(() -> store.getOrCreateMapping(key, factory).blockingGet())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("temporary allocation failure");

        SessionMapping retried = store.getOrCreateMapping(key, factory).blockingGet();
        SessionMapping cached = store.getOrCreateMapping(key, factory).blockingGet();

        assertThat(retried.sessionId()).isEqualTo("session-2");
        assertThat(cached).isSameAs(retried);
        assertThat(attempts).hasValue(2);
    }

    @Test
    void invalidationAllowsANewMappingToBeAllocated() {
        ThreadSessionMappingStore store = new InMemoryThreadSessionMappingStore();
        SessionMappingKey key = new SessionMappingKey("app", "user", "thread");

        store.getOrCreateMapping(key, factory(key, "session-one")).blockingGet();
        store.invalidate(key).blockingAwait();
        SessionMapping replacement = store.getOrCreateMapping(key, factory(key, "session-two")).blockingGet();

        assertThat(replacement.sessionId()).isEqualTo("session-two");
    }

    private static Supplier<Single<SessionMapping>> factory(SessionMappingKey key, String sessionId) {
        return () -> Single.just(new SessionMapping(key, sessionId));
    }

    private static final class DeliberatelyNonAtomicMappingStore implements ThreadSessionMappingStore {

        @Override
        public Single<SessionMapping> getOrCreateMapping(
                SessionMappingKey key, Supplier<Single<SessionMapping>> factory) {
            return Single.defer(factory::get);
        }

        @Override
        public Completable invalidate(SessionMappingKey key) {
            return Completable.complete();
        }

        @Override
        public boolean isDistributedAtomic() {
            return false;
        }
    }
}
