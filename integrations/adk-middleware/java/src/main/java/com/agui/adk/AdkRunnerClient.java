package com.agui.adk;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.RunConfig;
import com.google.genai.types.Content;
import io.reactivex.rxjava3.core.Flowable;

import java.util.Map;
import java.util.Optional;

/**
 * Adapter-local seam around Google ADK runner operations used by the bridge.
 */
public interface AdkRunnerClient extends AutoCloseable {

    /**
     * Returns the Google ADK application name.
     *
     * @return application name
     */
    String appName();

    /**
     * Starts an asynchronous Google ADK run.
     *
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @param content message content to submit
     * @param runConfig base Google ADK run configuration
     * @param stateDelta Google ADK invocation state delta
     * @return Google ADK event stream
     */
    Flowable<com.google.adk.events.Event> runAsync(
            String userId,
            String sessionId,
            Content content,
            RunConfig runConfig,
            Map<String, Object> stateDelta);

    /**
     * The root ADK agent this runner executes, when exposed (A2UI auto-injection and per-run
     * agent-tree preparation need the tree; opaque test doubles return empty).
     *
     * @return the runner's root agent, or empty when unavailable
     */
    default Optional<BaseAgent> rootAgent() {
        return Optional.empty();
    }

    /** Releases runner-owned resources. Implementations without resources may no-op. */
    @Override
    default void close() {
    }

    /**
     * Starts an asynchronous Google ADK run against an explicit per-run agent tree (rebuilt for
     * A2UI per-run tool binding). Defaults to the ordinary {@link #runAsync} overload when the
     * implementation cannot substitute a tree.
     *
     * @param userId Google ADK user identifier
     * @param sessionId Google ADK session identifier
     * @param content message content to submit
     * @param runConfig base Google ADK run configuration
     * @param stateDelta Google ADK invocation state delta
     * @param perRunAgent the per-run agent tree to execute
     * @return Google ADK event stream
     */
    default Flowable<com.google.adk.events.Event> runAsync(
            String userId,
            String sessionId,
            Content content,
            RunConfig runConfig,
            Map<String, Object> stateDelta,
            BaseAgent perRunAgent) {
        return runAsync(userId, sessionId, content, runConfig, stateDelta);
    }
}
