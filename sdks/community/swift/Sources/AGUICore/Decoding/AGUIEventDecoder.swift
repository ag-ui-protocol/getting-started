// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Decoder for AG-UI protocol events with polymorphic deserialization.
///
/// `AGUIEventDecoder` decodes JSON event data into strongly-typed event objects based on
/// the "type" field in the JSON. It uses a registry-based architecture that allows you to
/// customize which event types are supported and how unknown events are handled.
///
/// ## Basic Usage
///
/// ```swift
/// // Create a decoder with default settings (strict mode)
/// let decoder = AGUIEventDecoder()
///
/// // Decode an event from JSON data
/// let event = try decoder.decode(jsonData)
///
/// // Pattern match on the event type
/// switch event.eventType {
/// case .runStarted:
///     let runStarted = event as! RunStartedEvent
///     print("Run started: \(runStarted.runId)")
/// case .runFinished:
///     let runFinished = event as! RunFinishedEvent
///     print("Run finished: \(runFinished.runId)")
/// default:
///     print("Other event: \(event.eventType)")
/// }
/// ```
///
/// ## Configuration Modes
///
/// ### Strict Mode (Default)
///
/// In strict mode, unknown or unsupported events throw errors:
///
/// ```swift
/// let decoder = AGUIEventDecoder() // Default: .throwError
/// // Throws EventDecodingError.unknownEventType for unrecognized types
/// ```
///
/// ### Tolerant Mode
///
/// In tolerant mode, unknown events are returned as `UnknownEvent`:
///
/// ```swift
/// var config = AGUIEventDecoder.Configuration()
/// config.unknownEventStrategy = .returnUnknown
/// let decoder = AGUIEventDecoder(config: config)
///
/// let event = try decoder.decode(data)
/// if let unknown = event as? UnknownEvent {
///     print("Unknown event type: \(unknown.typeRaw)")
///     // Can still access raw JSON for forwarding or logging
/// }
/// ```
///
/// ## Custom Registries
///
/// You can provide a custom registry to control which event types are supported:
///
/// ```swift
/// let customRegistry: [EventType: AGUIEventDecoder.DecodeHandler] = [
///     .runStarted: { data, decoder in
///         try decoder.decode(RunStartedEventDTO.self, from: data).toDomain(rawEvent: data)
///     }
///     // Add more handlers as needed
/// ]
///
/// let decoder = AGUIEventDecoder(registry: customRegistry)
/// ```
///
/// ## Error Handling
///
/// The decoder throws `EventDecodingError` for various failure scenarios:
///
/// - `.missingTypeField`: The JSON is missing the required "type" field
/// - `.invalidJSON`: The JSON data is malformed or invalid
/// - `.unknownEventType(String)`: The event type is not recognized (strict mode only)
/// - `.unsupportedEventType(EventType)`: The event type is known but has no handler (strict mode only)
/// - `.decodingFailed(String)`: Field-level decoding errors with detailed messages
///
/// ## Thread Safety
///
/// `AGUIEventDecoder` maintains mutable state for the THINKING→REASONING backward-compat
/// remap (tracking IDs across event sequences). It must be used **serially** — one
/// `decode(_:)` call at a time. Create one decoder per agent run; do not share a decoder
/// across concurrent tasks. SSE streams guarantee serial delivery, so this is satisfied
/// automatically when decoding streamed events.
///
/// - SeeAlso: `AGUIEvent`, `EventType`, `EventDecodingError`, `UnknownEvent`
public struct AGUIEventDecoder: Sendable {

    /// Handler function type for decoding a specific event type.
    ///
    /// Each handler receives the raw JSON data and a `JSONDecoder`, and returns
    /// a decoded `AGUIEvent` instance. Handlers are responsible for:
    ///
    /// 1. Decoding the event-specific DTO from the JSON data
    /// 2. Converting the DTO to the domain event type
    /// 3. Preserving the raw event data for debugging/forwarding
    ///
    /// - Parameters:
    ///   - data: The raw JSON data for the event
    ///   - decoder: A `JSONDecoder` instance for decoding
    /// - Returns: A decoded `AGUIEvent` instance
    /// - Throws: `EventDecodingError` or `DecodingError` if decoding fails
    public typealias DecodeHandler = @Sendable (_ data: Data, _ decoder: JSONDecoder) throws -> any AGUIEvent

    /// Configuration options for the decoder.
    ///
    /// Use `Configuration` to customize decoder behavior, particularly how unknown
    /// or unsupported events are handled.
    ///
    /// ```swift
    /// var config = AGUIEventDecoder.Configuration()
    /// config.unknownEventStrategy = .returnUnknown
    /// let decoder = AGUIEventDecoder(config: config)
    /// ```
    public struct Configuration: Sendable {
        /// Strategy for handling unknown or unsupported event types.
        ///
        /// Defaults to `.throwError` (strict mode).
        public var unknownEventStrategy: UnknownEventStrategy = .throwError

        /// Creates a new configuration with default settings.
        public init() {}
    }

    /// Strategy for handling unknown or unsupported event types.
    ///
    /// - `.throwError`: Throw `EventDecodingError` when encountering unknown/unsupported events (strict mode)
    /// - `.returnUnknown`: Return `UnknownEvent` instances for unknown/unsupported events (tolerant mode)
    ///
    /// Tolerant mode is useful for:
    /// - Forward compatibility with future protocol extensions
    /// - Graceful degradation when some event types aren't implemented
    /// - Logging or forwarding events you don't understand yet
    public enum UnknownEventStrategy: Sendable {
        /// Throw an error when encountering unknown or unsupported events.
        ///
        /// This is the default behavior and ensures type safety by requiring
        /// all events to be properly decoded.
        case throwError

        /// Return `UnknownEvent` instances for unknown or unsupported events.
        ///
        /// Enables forward compatibility and graceful handling of events
        /// that aren't yet implemented or recognized.
        case returnUnknown
    }

    private let config: Configuration
    private let makeDecoder: @Sendable () -> JSONDecoder
    private let registry: [EventType: DecodeHandler]

    /// Mutable state for the THINKING→REASONING backward-compat remap.
    ///
    /// Stored as a reference type so the `Sendable` struct can hold mutable state.
    /// `AGUIEventDecoder` must be used serially (one decode at a time), which is
    /// guaranteed by SSE streams — events arrive sequentially on a single task.
    private let remapState: ThinkingRemapState

    // MARK: - Initialization

    /// Creates a new `AGUIEventDecoder`.
    ///
    /// - Parameters:
    ///   - config: Configuration options for the decoder (defaults to strict mode)
    ///   - makeDecoder: Factory function for creating `JSONDecoder` instances (defaults to standard `JSONDecoder()`)
    ///   - registry: Dictionary mapping event types to their decode handlers (defaults to `defaultRegistry()`)
    ///
    /// The decoder uses the provided registry to determine which event types can be decoded.
    /// If no registry is provided, it uses `defaultRegistry()` which includes all lifecycle events.
    ///
    /// The AG-UI wire protocol uses camelCase keys throughout, so the default `JSONDecoder`
    /// requires no key decoding strategy. Supply a custom `makeDecoder` only when you need
    /// additional configuration (e.g. a specific date decoding strategy).
    ///
    /// Example with custom JSON decoder:
    /// ```swift
    /// let decoder = AGUIEventDecoder(
    ///     makeDecoder: {
    ///         let d = JSONDecoder()
    ///         d.dateDecodingStrategy = .millisecondsSince1970
    ///         return d
    ///     }
    /// )
    /// ```
    public init(
        config: Configuration = .init(),
        makeDecoder: @escaping @Sendable () -> JSONDecoder = { JSONDecoder() },
        registry: [EventType: DecodeHandler] = AGUIEventDecoder.defaultRegistry()
    ) {
        self.config = config
        self.makeDecoder = makeDecoder
        self.registry = registry
        self.remapState = ThinkingRemapState()
    }

    // MARK: - Decoding

    /// Decodes JSON data into an `AGUIEvent` instance.
    ///
    /// The decoder performs polymorphic deserialization by:
    /// 1. Extracting the "type" field from the JSON
    /// 2. Looking up the appropriate decode handler in the registry
    /// 3. Invoking the handler to decode the event-specific data
    ///
    /// - Parameter data: The JSON data to decode
    /// - Returns: A decoded `AGUIEvent` instance (specific type depends on the "type" field)
    /// - Throws: `EventDecodingError` if decoding fails or the event type is unknown/unsupported (in strict mode)
    ///
    /// Example:
    /// ```swift
    /// let jsonData = """
    /// {
    ///   "type": "RUN_STARTED",
    ///   "threadId": "thread-123",
    ///   "runId": "run-456"
    /// }
    /// """.data(using: .utf8)!
    ///
    /// let decoder = AGUIEventDecoder()
    /// let event = try decoder.decode(jsonData)
    ///
    /// if let runStarted = event as? RunStartedEvent {
    ///     print("Run \(runStarted.runId) started in thread \(runStarted.threadId)")
    /// }
    /// ```
    public func decode(_ data: Data) throws -> any AGUIEvent {
        let decoder = makeDecoder()

        let disc = try decodeTypeDiscriminator(from: data, decoder: decoder)

        // Transparent backward compat: remap legacy THINKING_* wire events to REASONING_*,
        // mirroring the TypeScript SDK's BackwardCompatibility_0_0_45 middleware.
        if let (remappedData, remappedType) = remapThinkingEvent(data: data, typeRaw: disc.typeRaw) {
            guard let handler = registry[remappedType] else {
                return try handleMissingHandler(for: remappedType, typeRaw: disc.typeRaw, rawEvent: data)
            }
            return try executeHandler(handler, data: remappedData, decoder: decoder)
        }

        guard let type = EventType(rawValue: disc.typeRaw) else {
            return try handleUnknownEventType(typeRaw: disc.typeRaw, rawEvent: data)
        }

        guard let handler = registry[type] else {
            return try handleMissingHandler(for: type, typeRaw: disc.typeRaw, rawEvent: data)
        }

        return try executeHandler(handler, data: data, decoder: decoder)
    }

    /// Rewrites a legacy `THINKING_*` wire event to its `REASONING_*` equivalent.
    ///
    /// Agents built against protocol versions prior to 0.0.46 emit `THINKING_*` events.
    /// Rather than keeping deprecated event types in the public API, the decoder silently
    /// upgrades them — matching how the TypeScript SDK's `BackwardCompatibility_0_0_45`
    /// middleware handles the same transition.
    ///
    /// IDs are stable across all events in the same sequence:
    /// - `currentReasoningId` is shared by `THINKING_START` and `THINKING_END`.
    /// - `currentMessageId` is shared by `THINKING_TEXT_MESSAGE_START`, `_CONTENT`, and `_END`.
    ///
    /// This decoder must be used serially (one decode call at a time), which is
    /// guaranteed by SSE streams — events arrive sequentially on a single task.
    ///
    /// - Parameters:
    ///   - data: Raw JSON bytes from the SSE stream.
    ///   - typeRaw: The `"type"` discriminator string already extracted from `data`.
    /// - Returns: Rewritten JSON + the target `EventType`, or `nil` if no remapping is needed.
    private func remapThinkingEvent(data: Data, typeRaw: String) -> (Data, EventType)? {
        let targetType: EventType
        var extraFields: [String: Any]

        switch typeRaw {
        case "THINKING_START":
            let id = UUID().uuidString
            remapState.currentReasoningId = id
            targetType = .reasoningStart
            extraFields = ["messageId": id]

        case "THINKING_END":
            let id = remapState.currentReasoningId ?? UUID().uuidString
            remapState.currentReasoningId = nil
            targetType = .reasoningEnd
            extraFields = ["messageId": id]

        case "THINKING_TEXT_MESSAGE_START":
            let id = UUID().uuidString
            remapState.currentMessageId = id
            targetType = .reasoningMessageStart
            extraFields = ["messageId": id, "role": "assistant"]

        case "THINKING_TEXT_MESSAGE_CONTENT":
            let id = remapState.currentMessageId ?? UUID().uuidString
            targetType = .reasoningMessageContent
            extraFields = ["messageId": id]

        case "THINKING_TEXT_MESSAGE_END":
            let id = remapState.currentMessageId ?? UUID().uuidString
            remapState.currentMessageId = nil
            targetType = .reasoningMessageEnd
            extraFields = ["messageId": id]

        default:
            return nil
        }

        guard var jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        jsonObject["type"] = targetType.rawValue
        for (key, value) in extraFields {
            jsonObject[key] = value
        }

        guard let remappedData = try? JSONSerialization.data(withJSONObject: jsonObject) else {
            return nil
        }

        return (remappedData, targetType)
    }

    private func decodeTypeDiscriminator(from data: Data, decoder: JSONDecoder) throws -> TypeDiscriminator {
        do {
            return try decoder.decode(TypeDiscriminator.self, from: data)
        } catch let error as DecodingError {
            throw mapDecodingError(error)
        } catch {
            throw EventDecodingError.invalidJSON
        }
    }

    private func handleUnknownEventType(typeRaw: String, rawEvent: Data) throws -> any AGUIEvent {
        switch config.unknownEventStrategy {
        case .throwError:
            throw EventDecodingError.unknownEventType(typeRaw)
        case .returnUnknown:
            return UnknownEvent(typeRaw: typeRaw, rawEvent: rawEvent)
        }
    }

    private func handleMissingHandler(
        for type: EventType,
        typeRaw: String,
        rawEvent: Data
    ) throws -> any AGUIEvent {
        switch config.unknownEventStrategy {
        case .throwError:
            throw EventDecodingError.unsupportedEventType(type)
        case .returnUnknown:
            return UnknownEvent(typeRaw: typeRaw, rawEvent: rawEvent)
        }
    }

    private func executeHandler(
        _ handler: DecodeHandler,
        data: Data,
        decoder: JSONDecoder
    ) throws -> any AGUIEvent {
        do {
            return try handler(data, decoder)
        } catch let error as EventDecodingError {
            throw error
        } catch let error as DecodingError {
            throw mapDecodingError(error)
        } catch {
            throw EventDecodingError.decodingFailed(error.localizedDescription)
        }
    }

    // MARK: - Registry Management

    /// Returns the default registry of event type handlers.
    ///
    /// The default registry includes handlers for all lifecycle events:
    /// - `runStarted`, `runFinished`, `runError`
    /// - `stepStarted`, `stepFinished`
    ///
    /// Additional event categories (text messages, tool calls, state management, etc.)
    /// can be added by composing multiple registries together.
    ///
    /// - Returns: A dictionary mapping `EventType` to `DecodeHandler` functions
    ///
    /// Example of composing custom registries:
    /// ```swift
    /// let customRegistry = RegistryComposer.compose(
    ///     AGUIEventDecoder.defaultRegistry(),
    ///     MyCustomEventRegistry.registry()
    /// )
    /// let decoder = AGUIEventDecoder(registry: customRegistry)
    /// ```
    public static func defaultRegistry() -> [EventType: DecodeHandler] {
        RegistryComposer.compose(
            LifecycleEventRegistry.registry(),
            TextMessageEventRegistry.registry(),
            ToolCallEventRegistry.registry(),
            StateEventRegistry.registry(),
            SpecialEventRegistry.registry(),
            ReasoningEventRegistry.registry(),
            ActivityEventRegistry.registry()
        )
    }

    // MARK: - Error mapping

    private func mapDecodingError(_ error: DecodingError) -> EventDecodingError {
        func path(_ codingPath: [CodingKey]) -> String {
            let pathString = codingPath.map(\.stringValue).joined(separator: ".")
            return pathString.isEmpty ? "root" : pathString
        }

        switch error {
        case .keyNotFound(let key, _) where key.stringValue == "type":
            return .missingTypeField
        case .dataCorrupted:
            return .invalidJSON
        case .keyNotFound(let key, let ctx):
            return .decodingFailed("Missing key '\(key.stringValue)' at \(path(ctx.codingPath))")
        case .typeMismatch(let type, let ctx):
            return .decodingFailed("Type mismatch '\(type)' at \(path(ctx.codingPath))")
        case .valueNotFound(let type, let ctx):
            return .decodingFailed("Missing value '\(type)' at \(path(ctx.codingPath))")
        @unknown default:
            return .decodingFailed(String(describing: error))
        }
    }
}
