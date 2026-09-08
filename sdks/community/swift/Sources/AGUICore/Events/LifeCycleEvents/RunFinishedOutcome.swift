// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

/// Describes why an agent run finished.
///
/// Carried by `RunFinishedEvent` and decoded from the `"outcome"` field in the
/// AG-UI wire format. The field is a discriminated union object keyed on `"type"`:
///
/// ```json
/// { "type": "success" }
/// { "type": "interrupt", "interrupts": [ { "id": "...", "reason": "..." } ] }
/// ```
///
/// A `nil` outcome on `RunFinishedEvent` means the field was absent or `null` —
/// this occurs with legacy producers (e.g. the Python SDK using `model_dump()`
/// without `exclude_none=True`) and should be treated as a normal completion.
///
/// - SeeAlso: `RunFinishedEvent`, `Interrupt`
public enum RunFinishedOutcome: Equatable, Hashable, Sendable {

    /// The run completed normally.
    ///
    /// Wire: `{ "type": "success" }`
    case success

    /// The run paused and is waiting for human input.
    ///
    /// Wire: `{ "type": "interrupt", "interrupts": [...] }`
    ///
    /// The associated array contains at least one `Interrupt` describing what
    /// the agent is waiting for. Resume the run by sending a new `RunAgentInput`
    /// with a `resume` array referencing each interrupt's `id`.
    case interrupt([Interrupt])
}
