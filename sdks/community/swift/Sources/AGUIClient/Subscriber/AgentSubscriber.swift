// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - AgentStateMutation

/// Represents a mutation requested by an ``AgentSubscriber``.
///
/// Subscribers can replace the pending message collection, update state, or
/// stop propagation so the default handlers skip their own processing.
///
/// ## Example
///
/// ```swift
/// // Append a custom message
/// func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
///     var updatedMessages = params.messages
///     updatedMessages.append(SystemMessage(
///         id: "custom-prompt",
///         content: "Be concise and helpful."
///     ))
///     return AgentStateMutation(messages: updatedMessages)
/// }
/// ```
///
/// - SeeAlso: ``AgentSubscriber``
public struct AgentStateMutation: Sendable {
    /// Replacement messages for the agent's conversation history.
    ///
    /// When non-nil, these messages replace the current message list.
    public let messages: [any Message]?

    /// Updated state for the agent.
    ///
    /// When non-nil, this state replaces the current agent state.
    public let state: State?

    /// Whether to prevent default handlers from processing this event.
    ///
    /// When `true`, the agent's default event handlers will skip their
    /// normal processing, allowing the subscriber to fully control behavior.
    public let stopPropagation: Bool

    /// Creates a new agent state mutation.
    ///
    /// - Parameters:
    ///   - messages: Optional replacement messages
    ///   - state: Optional replacement state
    ///   - stopPropagation: Whether to stop default handler processing (default: false)
    public init(
        messages: [any Message]? = nil,
        state: State? = nil,
        stopPropagation: Bool = false
    ) {
        self.messages = messages
        self.state = state
        self.stopPropagation = stopPropagation
    }
}

// MARK: - Parameter Types

/// Common parameters shared across subscriber callbacks.
public struct AgentSubscriberParams: Sendable {
    /// Current conversation messages.
    public let messages: [any Message]

    /// Current agent state.
    public let state: State

    /// Input that started this run.
    public let input: RunAgentInput

    /// Creates new subscriber parameters.
    ///
    /// - Parameters:
    ///   - messages: Current conversation messages
    ///   - state: Current agent state
    ///   - input: Input that started this run
    public init(
        messages: [any Message],
        state: State,
        input: RunAgentInput
    ) {
        self.messages = messages
        self.state = state
        self.input = input
    }
}

/// Parameters delivered when subscribers observe a raw event.
public struct AgentEventParams: Sendable {
    /// The raw event from the event stream.
    public let event: any AGUIEvent

    /// Current conversation messages.
    public let messages: [any Message]

    /// Current agent state.
    public let state: State

    /// Input that started this run.
    public let input: RunAgentInput

    /// Creates new event parameters.
    ///
    /// - Parameters:
    ///   - event: The raw event from the stream
    ///   - messages: Current conversation messages
    ///   - state: Current agent state
    ///   - input: Input that started this run
    public init(
        event: any AGUIEvent,
        messages: [any Message],
        state: State,
        input: RunAgentInput
    ) {
        self.event = event
        self.messages = messages
        self.state = state
        self.input = input
    }
}

/// Parameters passed when the run fails with an exception.
public struct AgentRunFailureParams: Sendable {
    /// The error that caused the run to fail.
    public let error: Error

    /// Current conversation messages.
    public let messages: [any Message]

    /// Current agent state.
    public let state: State

    /// Input that started this run.
    public let input: RunAgentInput

    /// Creates new run failure parameters.
    ///
    /// - Parameters:
    ///   - error: The error that caused the failure
    ///   - messages: Current conversation messages
    ///   - state: Current agent state
    ///   - input: Input that started this run
    public init(
        error: Error,
        messages: [any Message],
        state: State,
        input: RunAgentInput
    ) {
        self.error = error
        self.messages = messages
        self.state = state
        self.input = input
    }
}

/// Parameters used when notifying subscribers of state or message changes.
public struct AgentStateChangedParams: Sendable {
    /// Current conversation messages.
    public let messages: [any Message]

    /// Current agent state.
    public let state: State

    /// Input that started this run.
    public let input: RunAgentInput

    /// Creates new state changed parameters.
    ///
    /// - Parameters:
    ///   - messages: Current conversation messages
    ///   - state: Current agent state
    ///   - input: Input that started this run
    public init(
        messages: [any Message],
        state: State,
        input: RunAgentInput
    ) {
        self.messages = messages
        self.state = state
        self.input = input
    }
}

// MARK: - AgentSubscription

/// Subscription handle returned by agent subscribe methods.
///
/// Use this to unsubscribe when you no longer want to receive callbacks.
///
/// ## Example
///
/// ```swift
/// let subscription = agent.subscribe(mySubscriber)
///
/// // Later, when done observing
/// await subscription.unsubscribe()
/// ```
public protocol AgentSubscription: Sendable {
    /// Unsubscribes from the agent, stopping all future callbacks.
    func unsubscribe() async
}

// MARK: - AgentSubscriber

/// Contract for observers that want to intercept lifecycle or event updates.
///
/// All callbacks are optional. Returning ``AgentStateMutation/stopPropagation`` = `true`
/// prevents the default handlers from mutating the agent state for that event.
///
/// ## Lifecycle Hooks
///
/// The subscriber provides six optional hooks:
///
/// - ``onRunInitialized(params:)``: Called when a run starts
/// - ``onEvent(params:)``: Called for each event in the stream
/// - ``onRunFinalized(params:)``: Called when a run completes successfully
/// - ``onRunFailed(params:)``: Called when a run fails with an error
/// - ``onMessagesChanged(params:)``: Called when messages are modified
/// - ``onStateChanged(params:)``: Called when state is modified
///
/// ## Example
///
/// ```swift
/// struct LoggingSubscriber: AgentSubscriber {
///     func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
///         print("Run started with \(params.messages.count) messages")
///         return nil
///     }
///
///     func onEvent(params: AgentEventParams) async -> AgentStateMutation? {
///         print("Received event: \(type(of: params.event))")
///         return nil
///     }
///
///     func onRunFinalized(params: AgentSubscriberParams) async -> AgentStateMutation? {
///         print("Run completed successfully")
///         return nil
///     }
/// }
///
/// let agent = HttpAgent(configuration: config)
/// let subscription = agent.subscribe(LoggingSubscriber())
/// ```
///
/// - SeeAlso: ``AgentStateMutation``, ``AgentSubscription``
public protocol AgentSubscriber: Sendable {
    /// Called when a run is initialized.
    ///
    /// This is called before the agent starts processing the input, allowing
    /// subscribers to inspect or modify the initial state and messages.
    ///
    /// - Parameter params: Common subscriber parameters
    /// - Returns: Optional mutation to apply before processing
    func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation?

    /// Called when a run fails with an error.
    ///
    /// This allows subscribers to log errors, implement retry logic, or
    /// modify the agent state in response to failures.
    ///
    /// - Parameter params: Failure parameters including the error
    /// - Returns: Optional mutation to apply after failure
    func onRunFailed(params: AgentRunFailureParams) async -> AgentStateMutation?

    /// Called when a run completes successfully.
    ///
    /// This is called after all events have been processed and the run
    /// has finished without errors.
    ///
    /// - Parameter params: Common subscriber parameters
    /// - Returns: Optional mutation to apply after completion
    func onRunFinalized(params: AgentSubscriberParams) async -> AgentStateMutation?

    /// Called for each event in the event stream.
    ///
    /// This allows subscribers to observe or react to individual events
    /// as they occur during the run.
    ///
    /// - Parameter params: Event parameters including the raw event
    /// - Returns: Optional mutation to apply for this event
    func onEvent(params: AgentEventParams) async -> AgentStateMutation?

    /// Called when the message list changes.
    ///
    /// This is a notification-only callback (does not return mutations).
    ///
    /// - Parameter params: State changed parameters with new messages
    func onMessagesChanged(params: AgentStateChangedParams) async

    /// Called when the agent state changes.
    ///
    /// This is a notification-only callback (does not return mutations).
    ///
    /// - Parameter params: State changed parameters with new state
    func onStateChanged(params: AgentStateChangedParams) async
}

// MARK: - Default Implementations

extension AgentSubscriber {
    /// Default implementation returns no mutation.
    public func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
        nil
    }

    /// Default implementation returns no mutation.
    public func onRunFailed(params: AgentRunFailureParams) async -> AgentStateMutation? {
        nil
    }

    /// Default implementation returns no mutation.
    public func onRunFinalized(params: AgentSubscriberParams) async -> AgentStateMutation? {
        nil
    }

    /// Default implementation returns no mutation.
    public func onEvent(params: AgentEventParams) async -> AgentStateMutation? {
        nil
    }

    /// Default implementation does nothing.
    public func onMessagesChanged(params: AgentStateChangedParams) async {}

    /// Default implementation does nothing.
    public func onStateChanged(params: AgentStateChangedParams) async {}
}
