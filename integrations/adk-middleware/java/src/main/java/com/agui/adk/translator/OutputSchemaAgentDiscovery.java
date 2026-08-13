package com.agui.adk.translator;

import com.google.adk.agents.BaseAgent;
import com.google.adk.agents.LlmAgent;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Discovers the names of agents that declare an {@code output_schema} anywhere in the agent tree
 * (port of the Python {@code ADKAgent._collect_output_schema_agent_names}, GitHub #1390).
 *
 * <p>These agents produce structured output (e.g. a classifier returning {@code "CHAT"}) that
 * must not appear as user-visible text messages in the chat UI. The returned set is handed to the
 * {@link EventTranslator} so {@code TextMessageEvent}s authored by these agents are suppressed.
 * In the Java ADK every nested agent (sequential, parallel, loop children) is exposed through
 * {@link BaseAgent#subAgents()}, which is the equivalent of the Python {@code sub_agents} +
 * {@code graph.nodes} walk.
 */
public final class OutputSchemaAgentDiscovery {

    private OutputSchemaAgentDiscovery() {
    }

    /**
     * Collects the names of every {@link LlmAgent} with an output schema in the tree rooted at the
     * supplied agent.
     *
     * @param root the root agent (may be null when the runner exposes no tree)
     * @return immutable set of agent names whose text must be suppressed
     */
    public static Set<String> collect(BaseAgent root) {
        Set<String> names = new LinkedHashSet<>();
        walk(root, names);
        return Set.copyOf(names);
    }

    /**
     * Recursively visits one agent and its sub-agents, collecting output_schema author names.
     *
     * @param agent the agent to visit (may be null)
     * @param names the mutable result set
     */
    private static void walk(BaseAgent agent, Set<String> names) {
        if (agent == null) {
            return;
        }
        if (agent instanceof LlmAgent llm && llm.outputSchema().isPresent()) {
            names.add(agent.name());
        }
        List<? extends BaseAgent> subAgents = agent.subAgents();
        if (subAgents != null) {
            for (BaseAgent sub : subAgents) {
                walk(sub, names);
            }
        }
    }
}
