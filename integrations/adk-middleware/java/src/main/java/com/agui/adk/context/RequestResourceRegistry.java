package com.agui.adk.context;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Owns request-scoped closeable resources and closes each resource at most once.
 */
public interface RequestResourceRegistry extends AutoCloseable {

    /**
     * Creates an empty request resource registry.
     *
     * @return new registry
     */
    static RequestResourceRegistry create() {
        return new DefaultRequestResourceRegistry();
    }

    /**
     * Returns the resource for a request-local key, creating and registering it when absent.
     *
     * @param resourceKey request-local resource key
     * @param factory resource factory
     * @param <T> resource type
     * @return existing or created resource
     */
    <T extends AutoCloseable> T computeIfAbsent(String resourceKey, Supplier<T> factory);

    /**
     * Registers a resource for exactly-once cleanup.
     *
     * @param resource resource to register
     */
    void register(AutoCloseable resource);

    /**
     * Closes every registered resource at most once.
     */
    @Override
    void close();
}

/**
 * Thread-safe default request resource registry.
 */
final class DefaultRequestResourceRegistry implements RequestResourceRegistry {

    private final Map<String, AutoCloseable> keyedResources = new LinkedHashMap<>();
    private final List<AutoCloseable> resources = new ArrayList<>();
    private final Set<AutoCloseable> registered =
            Collections.newSetFromMap(new IdentityHashMap<>());
    private boolean closed;

    @Override
    public synchronized <T extends AutoCloseable> T computeIfAbsent(
            String resourceKey,
            Supplier<T> factory) {
        Objects.requireNonNull(resourceKey, "resourceKey");
        Objects.requireNonNull(factory, "factory");
        AutoCloseable existing = keyedResources.get(resourceKey);
        if (existing != null) {
            @SuppressWarnings("unchecked")
            T typed = (T) existing;
            return typed;
        }
        if (closed) {
            throw new IllegalStateException("request resource registry is closed");
        }
        T created = Objects.requireNonNull(factory.get(), "factory returned null");
        register(created);
        keyedResources.put(resourceKey, created);
        return created;
    }

    @Override
    public synchronized void register(AutoCloseable resource) {
        Objects.requireNonNull(resource, "resource");
        if (closed) {
            if (registered.add(resource)) {
                closeResource(resource);
            }
            throw new IllegalStateException("request resource registry is closed");
        }
        if (registered.add(resource)) {
            resources.add(resource);
        }
    }

    @Override
    public void close() {
        List<AutoCloseable> pending;
        synchronized (this) {
            if (closed) {
                return;
            }
            closed = true;
            pending = new ArrayList<>(resources);
            resources.clear();
            keyedResources.clear();
        }

        RuntimeException failure = null;
        for (int index = pending.size() - 1; index >= 0; index--) {
            try {
                pending.get(index).close();
            } catch (Exception exception) {
                if (failure == null) {
                    failure = new IllegalStateException(
                            "failed to close request resource",
                            exception);
                } else {
                    failure.addSuppressed(exception);
                }
            }
        }
        if (failure != null) {
            throw failure;
        }
    }

    /**
     * Closes a resource created after the registry was already closed.
     *
     * @param resource resource to close
     */
    private static void closeResource(AutoCloseable resource) {
        try {
            resource.close();
        } catch (Exception exception) {
            throw new IllegalStateException("failed to close request resource", exception);
        }
    }
}
