package com.agui.adk.execution;

import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Request-scoped cooperative cancellation state. */
public final class CancellationToken {

    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final ConcurrentMap<CancellationRegistration, Runnable> listeners = new ConcurrentHashMap<>();

    /**
     * Cancels the request once and notifies listeners registered at the transition.
     *
     * @return {@code true} only for the transition to cancelled
     */
    public boolean cancel() {
        if (!cancelled.compareAndSet(false, true)) {
            return false;
        }
        listeners.forEach((registration, listener) -> {
            if (listeners.remove(registration, listener)) {
                listener.run();
            }
        });
        return true;
    }

    /**
     * Registers one callback that is invoked when this token is cancelled.
     * The returned registration must be closed when the owner no longer needs it.
     *
     * @param listener cancellation callback
     * @return deregistration handle
     */
    public AutoCloseable onCancel(Runnable listener) {
        CancellationRegistration registration = new CancellationRegistration();
        if (cancelled.get()) {
            listener.run();
            return registration;
        }
        listeners.put(registration, listener);
        if (cancelled.get() && listeners.remove(registration, listener)) {
            listener.run();
        }
        return registration;
    }

    /**
     * Reports whether cancellation was requested.
     *
     * @return cancellation state
     */
    public boolean isCancelled() {
        return cancelled.get();
    }

    /**
     * Fails when cancellation was requested.
     *
     * @throws CancellationException when cancelled
     */
    public void throwIfCancelled() {
        if (isCancelled()) {
            throw new CancellationException("AG-UI request was cancelled");
        }
    }

    /** One explicit listener registration. */
    private final class CancellationRegistration implements AutoCloseable {
        private final AtomicBoolean closed = new AtomicBoolean();

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                listeners.remove(this);
            }
        }
    }
}
