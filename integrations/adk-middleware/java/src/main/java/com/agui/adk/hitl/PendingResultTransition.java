package com.agui.adk.hitl;

/** Atomic result-submission outcome for one pending frontend-call group. */
public sealed interface PendingResultTransition
        permits BufferedToolResult, ResumeClaim, PendingResultTransition.Duplicate {
    /** The same result was accepted previously. */
    record Duplicate() implements PendingResultTransition { }
}
