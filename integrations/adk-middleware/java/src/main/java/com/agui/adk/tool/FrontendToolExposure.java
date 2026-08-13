package com.agui.adk.tool;

import com.agui.adk.context.AdkAgUiRunContext;

import java.util.Collection;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Request-scoped effective frontend tool names shared by ADK resolution and event translation. */
public final class FrontendToolExposure implements AutoCloseable {
    private static final String RESOURCE_KEY = FrontendToolExposure.class.getName();

    private final Set<String> names = ConcurrentHashMap.newKeySet();

    private FrontendToolExposure() { }

    /**
     * Returns the exposure registry owned by a run context.
     *
     * @param context current bridge run context
     * @return request-scoped registry
     */
    public static FrontendToolExposure from(AdkAgUiRunContext context) {
        return context.resources().computeIfAbsent(RESOURCE_KEY, FrontendToolExposure::new);
    }

    /**
     * Resets the client-visible name set after filtering and prefixing.
     *
     * @param effectiveNames names exposed to the model
     */
    public void reset(Collection<String> effectiveNames) {
        names.clear();
        names.addAll(effectiveNames);
    }

    /**
     * Adds names exposed by one of potentially several toolsets in the agent tree.
     *
     * @param effectiveNames additional names exposed to the model
     */
    public void addAll(Collection<String> effectiveNames) {
        names.addAll(effectiveNames);
    }

    /**
     * Returns the live request-scoped name set observed by event translation.
     *
     * @return live effective names
     */
    public Set<String> names() {
        return names;
    }

    @Override
    public void close() {
        names.clear();
    }
}
