package com.agui.adk.error;

/**
 * Stable machine-readable errors emitted by the Google ADK AG-UI bridge.
 *
 * <p>The vocabulary is a strict superset of the Python {@code ag_ui_adk} middleware's nine
 * {@code RunErrorEvent} codes, so a client that branches on the reference implementation's codes
 * (retry on {@code PENDING_TOOL_CALLS}, surface a banner on {@code EXECUTION_TIMEOUT}, ...) sees
 * the same values here. The remaining values are Java-specific refinements of failures the Python
 * bridge folds into its generic codes.
 */
public enum AdkAgUiErrorCode {
    // ---- Python `ag_ui_adk` vocabulary (exact names) ---- //

    /** Python {@code AGENT_ERROR}: the agent run failed at the transport boundary. */
    AGENT_ERROR,
    /** Python {@code BACKGROUND_EXECUTION_ERROR}: a detached background execution failed. */
    BACKGROUND_EXECUTION_ERROR,
    /** Python {@code ENCODING_ERROR}: an event could not be encoded for the wire. */
    ENCODING_ERROR,
    /** Python {@code EXECUTION_ERROR}: generic execution failure. */
    EXECUTION_ERROR,
    /** Python {@code EXECUTION_TIMEOUT}: the run exceeded its configured time budget. */
    EXECUTION_TIMEOUT,
    /** Python {@code NO_TOOL_RESULTS}: a tool-result submission carried no tool results. */
    NO_TOOL_RESULTS,
    /** Python {@code PENDING_TOOL_CALLS}: long-running calls from this turn are still unanswered. */
    PENDING_TOOL_CALLS,
    /** Python {@code TOOL_RESULT_BUFFER_ERROR}: buffering a partial tool-result group failed. */
    TOOL_RESULT_BUFFER_ERROR,
    /** Python {@code TOOL_RESULT_PROCESSING_ERROR}: processing submitted tool results failed. */
    TOOL_RESULT_PROCESSING_ERROR,

    // ---- Java-specific refinements (no Python counterpart) ---- //

    /** The request was rejected before an accepted run was allocated. */
    INVALID_RUN_INPUT,
    /** A frontend tool name collides with another frontend or configured backend tool. */
    DUPLICATE_TOOL_NAME,
    /** An official resume request is malformed or violates its immutable schema. */
    INVALID_RESUME,
    /** An interrupt is unknown or outside the trusted principal/session scope. */
    UNKNOWN_INTERRUPT,
    /** A user cancelled an outstanding human-in-the-loop decision. */
    HITL_CANCELLED,
    /** A submitted tool result does not correlate with any known call. */
    UNKNOWN_TOOL_RESULT,
    /** Resolving or mutating the ADK session failed. */
    SESSION_FAILURE,
    /** The process-local global execution limit rejected the run. */
    CONCURRENCY_LIMIT,
    /** The run was cancelled. */
    CANCELLATION,
    /** A durable bridge store operation failed. */
    PERSISTENCE_FAILURE,
    /** An auth request arrived without a configured adapter. */
    UNSUPPORTED_AUTH_REQUEST,
    /** The ADK runner itself failed. */
    ADK_EXECUTION_FAILURE
}
