package com.agui.community.spring.server.core;

/**
 * Thrown when a request addresses an agent id that is not registered. Each
 * server module's controller maps this to {@code 404 Not Found}.
 */
public class AgentNotFoundException extends RuntimeException {

    private AgentNotFoundException(String message) {
        super(message);
    }

    /**
     * @param id the unknown agent id from the request path
     * @return an exception describing the missing id
     */
    public static AgentNotFoundException byId(String id) {
        return new AgentNotFoundException("No agent registered with id '" + id + "'");
    }

    /**
     * @return an exception for a request to the base path when there is not
     *         exactly one registered agent to serve as the default
     */
    public static AgentNotFoundException noSingleAgent() {
        return new AgentNotFoundException(
                "No default agent: the base path requires exactly one registered agent");
    }
}
