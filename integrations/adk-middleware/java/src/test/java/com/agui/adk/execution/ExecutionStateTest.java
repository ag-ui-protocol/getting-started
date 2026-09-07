package com.agui.adk.execution;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ExecutionStateTest {

    @Test
    void reportsRunningBeforeCompletion() {
        ExecutionState state = new ExecutionState("thread-1");
        assertThat(state.getStatus()).isEqualTo("running");
        assertThat(state.hasPendingToolCalls()).isFalse();
    }

    @Test
    void reportsCompleteWhenFinishedWithoutPendingTools() {
        ExecutionState state = new ExecutionState("thread-1");
        state.markComplete();
        assertThat(state.getStatus()).isEqualTo("complete");
    }

    @Test
    void reportsCompleteAwaitingToolsWhenFinishedWithPendingTools() {
        ExecutionState state = new ExecutionState("thread-1");
        state.addPendingToolCall("call_1");
        state.markComplete();
        assertThat(state.getStatus()).isEqualTo("complete_awaiting_tools");
        state.removePendingToolCall("call_1");
        assertThat(state.getStatus()).isEqualTo("complete");
    }

    @Test
    void reportOrderMatchesPythonGetStatusPrecedence() {
        // Python: complete + pending -> complete_awaiting_tools BEFORE complete.
        ExecutionState state = new ExecutionState("thread-1");
        state.markComplete();
        state.addPendingToolCall("call_1");
        assertThat(state.getStatus()).isEqualTo("complete_awaiting_tools");
    }

    @Test
    void reportsTaskDoneTransientStateBeforeCompletion() {
        // Python get_status precedence: complete+pending -> complete_awaiting_tools;
        // else task.done() -> task_done; else running.
        ExecutionState running = new ExecutionState("t");
        assertThat(running.getStatus()).isEqualTo("running");
        ExecutionState done = new ExecutionState("t");
        done.markTaskDone();
        assertThat(done.getStatus()).isEqualTo("task_done");
        // complete takes precedence over task_done
        done.markComplete();
        assertThat(done.getStatus()).isEqualTo("complete");
        done.addPendingToolCall("c");
        assertThat(done.getStatus()).isEqualTo("complete_awaiting_tools");
    }

    @Test
    void getExecutionTimeIsNonNegativeAndGrows() {
        ExecutionState state = new ExecutionState("t");
        double first = state.getExecutionTime();
        assertThat(first).isGreaterThanOrEqualTo(0.0);
        // elapsed time must not go backwards for the same state
        double second = state.getExecutionTime();
        assertThat(second).isGreaterThanOrEqualTo(first);
    }
}