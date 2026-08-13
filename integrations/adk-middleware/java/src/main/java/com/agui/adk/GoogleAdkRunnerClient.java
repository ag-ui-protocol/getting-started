package com.agui.adk;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.RunConfig;
import com.google.adk.runner.Runner;
import com.google.genai.types.Content;
import io.reactivex.rxjava3.core.Flowable;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Production {@link AdkRunnerClient} backed by the official Google ADK runner.
 */
public final class GoogleAdkRunnerClient implements AdkRunnerClient {

    private final Runner runner;

    /**
     * Creates a client for an official Google ADK runner.
     *
     * @param runner runner to delegate to
     */
    public GoogleAdkRunnerClient(Runner runner) {
        this.runner = Objects.requireNonNull(runner, "runner");
    }

    @Override
    public String appName() {
        return runner.appName();
    }

    @Override
    public Flowable<com.google.adk.events.Event> runAsync(
            String userId,
            String sessionId,
            Content content,
            RunConfig runConfig,
            Map<String, Object> stateDelta) {
        return runner.runAsync(userId, sessionId, content, runConfig, stateDelta);
    }

    @Override
    public Optional<BaseAgent> rootAgent() {
        return Optional.ofNullable(runner.agent());
    }

    @Override
    public void close() {
        runner.close().blockingAwait();
    }

    @Override
    public Flowable<com.google.adk.events.Event> runAsync(
            String userId,
            String sessionId,
            Content content,
            RunConfig runConfig,
            Map<String, Object> stateDelta,
            BaseAgent perRunAgent) {
        if (perRunAgent == null || perRunAgent == runner.agent()) {
            return runAsync(userId, sessionId, content, runConfig, stateDelta);
        }
        // The Runner is immutable and wraps the construction-time agent; an A2UI per-run tree is
        // executed by rebuilding a Runner around it, carrying the same services/plugins so the run
        // behaves identically except for the substituted agent tree.
        Runner rebuilt = Runner.builder()
                .appName(runner.appName())
                .agent(perRunAgent)
                .artifactService(runner.artifactService())
                .sessionService(runner.sessionService())
                .memoryService(runner.memoryService())
                .plugins(runner.pluginManager().getPlugins())
                .build();
        return rebuilt.runAsync(userId, sessionId, content, runConfig, stateDelta);
    }
}
