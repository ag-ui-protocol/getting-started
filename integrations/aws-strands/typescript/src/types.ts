/** Internal bookkeeping for an in-flight tool call. */
export interface SeenToolCall {
  name: string;
  args: string;
  input: unknown;
  emitted: boolean;
  strandsToolId: string;
  /** Whether TOOL_CALL_START has already gone on the wire. */
  startEmitted?: boolean;
  /** Whether TOOL_CALL_END has already gone on the wire. */
  endEmitted?: boolean;
  /**
   * High-water mark of the raw args string already emitted as TOOL_CALL_ARGS
   * deltas. Each subsequent chunk emits only the growth.
   */
  lastEmittedRawLen?: number;
  /**
   * Whether this call's assembled `ToolUseBlock` has already been sighted. The
   * SDK re-delivers each assembled block exactly once, so this is what
   * separates that re-delivery from a later block reusing the same native id.
   */
  assembledSeen?: boolean;
  isPending?: boolean;
  isFrontend?: boolean;
  useStreaming?: boolean;
  raw?: string;
}
