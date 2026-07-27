package com.agui.community.core.agent;

import com.agui.community.core.event.Event;
import java.util.concurrent.Flow;

/**
 * An AG-UI agent: the unit that processes a {@link RunAgentInput} and responds
 * by emitting a stream of {@link Event}s describing the run.
 *
 * <p>The result is a {@link Flow.Publisher}, the Reactive Streams interface
 * built into the JDK, so that {@code core} stays free of any third-party
 * streaming dependency. Integration modules may adapt the publisher to richer
 * reactive types (such as Project Reactor's {@code Flux} or RxJava) at their
 * edges.
 *
 * <p>Each subscription represents one run: the publisher emits the run's events
 * in order and then completes, or signals {@code onError} if the run fails.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/agents">AG-UI Agents</a>
 */
@FunctionalInterface
public interface Agent {

    /**
     * Runs the agent for the given input.
     *
     * @param input the run input bundling the conversation, tools, context and
     *              state (required)
     * @return a publisher that emits the run's {@link Event}s in order and then
     *         completes, or signals {@code onError} on failure
     */
    Flow.Publisher<Event> run(RunAgentInput input);
}
