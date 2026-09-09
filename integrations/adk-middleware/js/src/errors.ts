/** Every `code` the bridge throws as an `ADKJSProtocolError` or puts on `RUN_ERROR`. */
export type ADKJSErrorCode =
  // run coordination
  | "THREAD_BUSY"
  | "INVALID_USER_ID"
  | "STREAMING_MODE_UNSUPPORTED"
  | "CLIENT_TOOLS_UNSUPPORTED"
  | "CLIENT_TOOLSET_NOT_PLACED"
  | "ABORTED"
  // interrupts and resume
  | "PENDING_INTERRUPTS"
  | "NO_NEW_INPUT"
  | "RESUME_WITH_NEW_INPUT"
  | "DUPLICATE_INTERRUPT_ID"
  | "UNKNOWN_INTERRUPT_ID"
  | "PARTIAL_RESUME"
  | "INVALID_PAYLOAD"
  | "INVALID_RESPONSE_SCHEMA"
  | "INVALID_REPLAY_ARTIFACT"
  | "STALE_RESUME"
  | "UNSUPPORTED_INTERRUPT_CANCELLATION"
  | "INTENT_MISMATCH"
  // credentials
  | "INVALID_AUTH_CONFIG"
  | "INVALID_CREDENTIAL_PAYLOAD"
  // state
  | "RESERVED_STATE_KEY"
  | "RESERVED_STATE_SCOPE"
  // message conversion
  | "UNSUPPORTED_MESSAGE_ROLE"
  | "UNKNOWN_TOOL_CALL"
  | "UNSUPPORTED_BINARY_REFERENCE"
  | "INVALID_TOOL_ARGUMENTS"
  | "UNKNOWN_AGENT_AUTHOR";

/**
 * The one error the bridge raises. `code` is an `ADKJSErrorCode` for anything
 * the bridge decides itself; an ADK error event passes its own code through.
 */
export class ADKJSProtocolError extends Error {
  constructor(
    message: string,
    readonly code: ADKJSErrorCode | (string & {}),
  ) {
    super(message);
    this.name = "ADKJSProtocolError";
  }
}
