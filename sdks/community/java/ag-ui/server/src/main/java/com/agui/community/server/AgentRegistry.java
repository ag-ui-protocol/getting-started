package com.agui.community.server;

import com.agui.community.core.agent.Agent;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * A lookup from agent id to {@link Agent}, used to route a request to one of
 * several agents addressed by a path segment (for example {@code /agent/{id}}).
 *
 * <p>This is transport-neutral: a transport adapter resolves an {@link Agent}
 * through this registry and decides for itself how to signal that an id is
 * unknown (the JDK handler responds {@code 404}). When exactly one agent is
 * registered, {@link #single()} lets an adapter also serve it on the base path
 * as a convenience alias.
 */
public interface AgentRegistry {

    /**
     * Resolves the agent registered under the given id.
     *
     * @param id the agent id taken from the request path (required)
     * @return the matching agent, or empty if none is registered under {@code id}
     */
    Optional<Agent> find(String id);

    /**
     * @return the ids of every registered agent (never {@code null})
     */
    Set<String> ids();

    /**
     * @return the only registered agent if exactly one is registered, otherwise
     *         empty. Adapters use this to serve a single-agent alias on the base
     *         path.
     */
    default Optional<Agent> single() {
        Set<String> ids = ids();
        return ids.size() == 1 ? find(ids.iterator().next()) : Optional.empty();
    }

    /**
     * Creates a registry backed by a defensive copy of the given map.
     *
     * @param agents the id-to-agent mappings (required; no null keys or values)
     * @return an immutable registry over those mappings
     */
    static AgentRegistry of(Map<String, Agent> agents) {
        Objects.requireNonNull(agents, "agents must not be null");
        Map<String, Agent> copy = Map.copyOf(agents);
        return new AgentRegistry() {
            @Override
            public Optional<Agent> find(String id) {
                return Optional.ofNullable(copy.get(id));
            }

            @Override
            public Set<String> ids() {
                return copy.keySet();
            }
        };
    }
}
