package com.agui.adk.a2ui;

import com.agui.community.core.event.Event;
import com.agui.community.core.event.ToolCallEndEvent;
import io.reactivex.rxjava3.core.Flowable;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Bridges the A2UI sub-agent tool's per-run nested-tool-call queue onto the public run's event
 * stream (Python's concurrent queue consumer). The tool streams {@code TOOL_CALL_START/ARGS/END}
 * events for its inner {@code render_a2ui} call onto the run's queue; {@link #drain} turns that
 * queue into a {@link Flowable} that terminates when the run-level producer signals completion via
 * {@link #terminal()}.
 *
 * <p>Termination protocol: the owning {@code GoogleAdkAgent} execution puts exactly one shared
 * {@link #terminal()} marker after the complete ADK run terminates. Individual
 * {@link A2UISubAgentTool} invocations enqueue only nested events, so overlapping tools cannot stop
 * progressive draining for their peers. A cancelled run is bounded by the caller against the run
 * stream's completion.
 */
public final class A2uiQueueDrain {

    private static final long POLL_TIMEOUT_MILLIS = 25;

    /** Reserved nested tool-call id of the completion marker (never a real render call id). */
    private static final String TERMINAL_TOOL_CALL_ID = "__a2ui_queue_done__";
    private static final Event TERMINAL = new ToolCallEndEvent(TERMINAL_TOOL_CALL_ID);

    private A2uiQueueDrain() {
    }

    /**
     * The completion marker the run-level producer queues after all run processing finishes.
     *
     * @return the shared terminal marker
     */
    public static Event terminal() {
        return TERMINAL;
    }

    /**
     * Turns the per-run queue into a flowable of nested AG-UI events, completing when the
     * {@link #terminal()} marker is observed (dropped, not emitted).
     *
     * @param queue the per-run event queue bound to the run's A2UI tool clones
     * @return the draining flowable
     */
    public static Flowable<Event> drain(BlockingQueue<Event> queue) {
        return Flowable.generate(emitter -> {
            while (true) {
                Event event;
                try {
                    event = queue.poll(POLL_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    emitter.onComplete();
                    return;
                }
                if (event == null) {
                    continue;
                }
                if (isTerminal(event)) {
                    emitter.onComplete();
                    return;
                }
                emitter.onNext(event);
                return;
            }
        });
    }

    /**
     * Emits any events still queued when the run stream terminated (cancellation / no tool
     * invocation): a final non-blocking sweep that drops the terminal marker. Used to bound the
     * drain against run completion without losing stragglers.
     *
     * @param queue the per-run event queue
     * @return a flowable of the remaining non-terminal events
     */
    public static Flowable<Event> drainRemaining(BlockingQueue<Event> queue) {
        java.util.List<Event> out = new java.util.ArrayList<>();
        Event event;
        while ((event = queue.poll()) != null) {
            if (!isTerminal(event)) {
                out.add(event);
            }
        }
        return Flowable.fromIterable(out);
    }

    /**
     * Whether the event is the queue-completion marker (identity or reserved id — the marker is a
     * singleton, so identity suffices; the id check keeps copies robust).
     *
     * @param event the queued event
     * @return true for the terminal marker
     */
    private static boolean isTerminal(Event event) {
        return event == TERMINAL
                || (event instanceof ToolCallEndEvent tce
                && TERMINAL_TOOL_CALL_ID.equals(tce.toolCallId()));
    }
}
