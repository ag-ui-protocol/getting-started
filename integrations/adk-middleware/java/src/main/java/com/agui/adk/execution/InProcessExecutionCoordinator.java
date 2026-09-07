package com.agui.adk.execution;

import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.core.SingleObserver;
import io.reactivex.rxjava3.disposables.Disposable;
import io.reactivex.rxjava3.exceptions.Exceptions;
import io.reactivex.rxjava3.plugins.RxJavaPlugins;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Objects;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Process-local, per-key FIFO execution coordinator. */
public final class InProcessExecutionCoordinator implements ExecutionCoordinator {

    private final ConcurrentMap<ExecutionKey, QueueState> queues = new ConcurrentHashMap<>();

    @Override
    public Single<ExecutionLease> acquire(ExecutionKey key, CancellationToken cancellation) {
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(cancellation, "cancellation");
        return new Acquisition(key, cancellation);
    }

    @Override
    public boolean isDistributed() {
        return false;
    }

    /** One lazily subscribed execution acquisition. */
    private final class Acquisition extends Single<ExecutionLease> {
        private final ExecutionKey key;
        private final CancellationToken cancellation;

        /**
         * Creates one acquisition.
         *
         * @param key execution identity
         * @param cancellation request cancellation state
         */
        private Acquisition(ExecutionKey key, CancellationToken cancellation) {
            this.key = key;
            this.cancellation = cancellation;
        }

        @Override
        protected void subscribeActual(SingleObserver<? super ExecutionLease> observer) {
            Waiter waiter = new Waiter(cancellation, observer);
            observer.onSubscribe(waiter);
            if (waiter.isDisposed()) {
                return;
            }
            waiter.setCancellationRegistration(
                    cancellation.onCancel(waiter::requestTokenCancellation));
            enqueue(key, waiter);
        }
    }

    /**
     * Enqueues one acquisition or reports an already-cancelled request.
     *
     * @param key execution identity
     * @param waiter pending acquisition
     */
    private void enqueue(ExecutionKey key, Waiter waiter) {
        while (true) {
            QueueState state = queues.computeIfAbsent(key, ignored -> new QueueState());
            boolean cancelled;
            synchronized (state) {
                if (queues.get(key) != state) {
                    continue;
                }
                if (waiter.cancellation.isCancelled()) {
                    waiter.requestTokenCancellation();
                }
                cancelled = !waiter.isPending();
                if (cancelled) {
                    if (!state.active && !state.draining && state.waiters.isEmpty()) {
                        queues.remove(key, state);
                    }
                } else {
                    state.waiters.addLast(waiter);
                }
            }
            if (cancelled) {
                waiter.closeCancellationRegistration();
                waiter.failCancellation();
            } else {
                drain(key, state);
            }
            return;
        }
    }

    /**
     * Selects FIFO work while holding the queue monitor and invokes every reactive callback after
     * releasing it. A caller that cancels only changes its waiter's atomic ownership state; this
     * drain performs queue removal and terminal delivery when queue work next progresses.
     *
     * @param key execution identity
     * @param state queue to drain
     */
    private void drain(ExecutionKey key, QueueState state) {
        synchronized (state) {
            if (state.draining) {
                return;
            }
            state.draining = true;
        }
        while (true) {
            Delivery delivery;
            boolean idle;
            synchronized (state) {
                delivery = nextDelivery(key, state);
                idle = delivery == null && !state.active && state.waiters.isEmpty();
                if (delivery == null) {
                    state.draining = false;
                    if (idle) {
                        queues.remove(key, state);
                    }
                }
            }
            if (delivery == null) {
                return;
            }
            delivery.deliver();
        }
    }

    /**
     * Selects the next callback to deliver without invoking it under the monitor.
     *
     * @param key execution identity
     * @param state queue being drained
     * @return selected callback or {@code null} when no delivery is available
     */
    private Delivery nextDelivery(ExecutionKey key, QueueState state) {
        while (!state.active && !state.waiters.isEmpty()) {
            Waiter waiter = state.waiters.removeFirst();
            if (waiter.cancellation.isCancelled()) {
                waiter.requestTokenCancellation();
            }
            if (!waiter.isPending()) {
                return new Delivery(waiter, null, true);
            }
            state.active = true;
            state.activeWaiter = waiter;
            ExecutionLease lease = lease(key, state, waiter);
            if (!waiter.select()) {
                return new Delivery(waiter, lease, true);
            }
            return new Delivery(waiter, lease, false);
        }
        return null;
    }

    /**
     * Creates one idempotent active-lease release action.
     *
     * @param key execution identity
     * @param state queue holding the active lease
     * @param waiter selected acquisition
     * @return idempotent lease close action
     */
    private ExecutionLease lease(ExecutionKey key, QueueState state, Waiter waiter) {
        AtomicBoolean closed = new AtomicBoolean();
        return () -> {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            synchronized (state) {
                if (state.activeWaiter != waiter) {
                    return;
                }
                state.active = false;
                state.activeWaiter = null;
            }
            drain(key, state);
        };
    }

    /** Mutable per-key FIFO queue state protected by its monitor. */
    private static final class QueueState {
        private final Deque<Waiter> waiters = new ArrayDeque<>();
        private boolean active;
        private boolean draining;
        private Waiter activeWaiter;
    }

    /** One selected reactive callback, intentionally delivered outside the queue monitor. */
    private final class Delivery {
        private final Waiter waiter;
        private final ExecutionLease lease;
        private final boolean cancellation;

        /**
         * Creates one deferred callback delivery.
         *
         * @param waiter selected acquisition
         * @param lease selected lease, if any
         * @param cancellation whether this is cancellation delivery
         */
        private Delivery(Waiter waiter, ExecutionLease lease, boolean cancellation) {
            this.waiter = waiter;
            this.lease = lease;
            this.cancellation = cancellation;
        }

        /** Delivers this selected callback after the queue monitor is released. */
        private void deliver() {
            if (cancellation) {
                if (lease != null) {
                    lease.close();
                }
                waiter.closeCancellationRegistration();
                deliverCancellation();
            } else if (!waiter.deliver(lease)) {
                lease.close();
                waiter.closeCancellationRegistration();
                deliverCancellation();
            }
        }

        /** Delivers cancellation while containing nonfatal downstream callback failures. */
        private void deliverCancellation() {
            try {
                waiter.failCancellation();
            } catch (Throwable error) {
                Exceptions.throwIfFatal(error);
                RxJavaPlugins.onError(error);
            }
        }
    }

    /** One pending or active execution acquisition. */
    private final class Waiter implements Disposable {
        private static final int PENDING = 0;
        private static final int SELECTED = 1;
        private static final int TRANSFERRED = 2;
        private static final int TOKEN_CANCELLED = 3;
        private static final int DISPOSED = 4;
        private static final int CANCELLATION_DELIVERED = 5;

        private final CancellationToken cancellation;
        private final SingleObserver<? super ExecutionLease> observer;
        private final AtomicInteger ownership = new AtomicInteger(PENDING);
        private final AtomicReference<AutoCloseable> cancellationRegistration =
                new AtomicReference<>();

        /**
         * Creates one pending acquisition.
         *
         * @param cancellation request cancellation state
         * @param observer reactive result observer
         */
        private Waiter(CancellationToken cancellation,
                       SingleObserver<? super ExecutionLease> observer) {
            this.cancellation = cancellation;
            this.observer = observer;
        }

        /**
         * Records queue selection unless cancellation or disposal already owns the waiter.
         *
         * @return whether selection acquired waiter ownership
         */
        private boolean select() {
            return ownership.compareAndSet(PENDING, SELECTED);
        }

        /**
         * Whether this waiter remains eligible for FIFO admission.
         *
         * @return whether queue admission remains pending
         */
        private boolean isPending() {
            return ownership.get() == PENDING;
        }

        /** Makes token cancellation observable without taking the queue monitor. */
        private void requestTokenCancellation() {
            while (true) {
                int current = ownership.get();
                if (current != PENDING && current != SELECTED) {
                    return;
                }
                if (ownership.compareAndSet(current, TOKEN_CANCELLED)) {
                    return;
                }
            }
        }

        @Override
        public void dispose() {
            while (true) {
                int current = ownership.get();
                if (current == DISPOSED
                        || current == TRANSFERRED
                        || current == CANCELLATION_DELIVERED) {
                    return;
                }
                if (ownership.compareAndSet(current, DISPOSED)) {
                    closeCancellationRegistration();
                    return;
                }
            }
        }

        @Override
        public boolean isDisposed() {
            int current = ownership.get();
            return current == DISPOSED
                    || current == TRANSFERRED
                    || current == CANCELLATION_DELIVERED;
        }

        /**
         * Delivers a selected lease outside the queue monitor.
         *
         * @param lease selected lease
         * @return whether delivery atomically transferred lease ownership downstream
         */
        private boolean deliver(ExecutionLease lease) {
            refreshCancellationRegistration();
            if (cancellation.isCancelled()) {
                requestTokenCancellation();
            }
            if (!ownership.compareAndSet(SELECTED, TRANSFERRED)) {
                return false;
            }
            closeCancellationRegistration();
            try {
                observer.onSuccess(lease);
            } catch (Throwable error) {
                Exceptions.throwIfFatal(error);
                try {
                    lease.close();
                } finally {
                    RxJavaPlugins.onError(error);
                }
            }
            return true;
        }

        /** Delivers token cancellation outside the queue monitor. */
        private void failCancellation() {
            if (ownership.compareAndSet(TOKEN_CANCELLED, CANCELLATION_DELIVERED)) {
                observer.onError(new CancellationException("execution acquisition cancelled"));
            }
        }

        /**
         * Installs the first cancellation listener without leaking a concurrent disposal.
         *
         * @param registration listener deregistration handle
         */
        private void setCancellationRegistration(AutoCloseable registration) {
            replaceCancellationRegistration(registration);
            if (ownership.get() != PENDING) {
                closeCancellationRegistration();
            }
        }

        /** Keeps cancellation observable while the originally queued listener is deregistered. */
        private void refreshCancellationRegistration() {
            AutoCloseable replacement = cancellation.onCancel(this::requestTokenCancellation);
            replaceCancellationRegistration(replacement);
            if (ownership.get() != SELECTED) {
                closeCancellationRegistration();
            }
        }

        /**
         * Replaces and closes the prior local cancellation listener.
         *
         * @param replacement new listener deregistration handle
         */
        private void replaceCancellationRegistration(AutoCloseable replacement) {
            AutoCloseable previous = cancellationRegistration.getAndSet(replacement);
            closeRegistration(previous);
        }

        /** Closes the current request cancellation listener after ownership settles. */
        private void closeCancellationRegistration() {
            closeRegistration(cancellationRegistration.getAndSet(null));
        }

        /**
         * Closes one local cancellation deregistration handle.
         *
         * @param registration listener deregistration handle
         */
        private void closeRegistration(AutoCloseable registration) {
            if (registration != null) {
                try {
                    registration.close();
                } catch (Exception ignored) {
                    // Closing a local deregistration handle cannot affect acquisition correctness.
                }
            }
        }
    }
}
