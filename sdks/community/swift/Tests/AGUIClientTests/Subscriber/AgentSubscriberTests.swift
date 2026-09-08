// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
@testable import AGUIClient
import XCTest

final class AgentSubscriberTests: XCTestCase {

    // MARK: - Test Helpers

    private var testInput: RunAgentInput!
    private var testMessages: [any Message]!
    private var testState: State!

    override func setUp() async throws {
        try await super.setUp()

        testMessages = [
            SystemMessage(id: "sys1", content: "You are helpful"),
            UserMessage(id: "usr1", content: "Hello")
        ]

        testState = Data("{}".utf8)

        testInput = try RunAgentInput.builder()
            .threadId("test-thread")
            .runId("test-run")
            .messages(testMessages)
            .state(testState)
            .build()
    }

    // MARK: - Basic Lifecycle Tests

    func testOnRunInitializedCalled() async throws {
        // Given: A subscriber that tracks initialization
        let subscriber = MockAgentSubscriber()

        // When: Calling onRunInitialized
        let params = AgentSubscriberParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onRunInitialized(params: params)

        // Then: Should be called and tracked
        let calls = await subscriber.initializeCalls
        XCTAssertEqual(calls, 1)
        XCTAssertNil(mutation) // Default returns nil
    }

    func testOnEventCalled() async throws {
        // Given: A subscriber that tracks events
        let subscriber = MockAgentSubscriber()
        let event = RunStartedEvent(
            threadId: "test",
            runId: "test",
            timestamp: 1000,
            rawEvent: nil
        )

        // When: Calling onEvent
        let params = AgentEventParams(
            event: event,
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onEvent(params: params)

        // Then: Should be called and tracked
        let calls = await subscriber.eventCalls
        XCTAssertEqual(calls, 1)
        XCTAssertNil(mutation)
    }

    func testOnRunFinalizedCalled() async throws {
        // Given: A subscriber that tracks finalization
        let subscriber = MockAgentSubscriber()

        // When: Calling onRunFinalized
        let params = AgentSubscriberParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onRunFinalized(params: params)

        // Then: Should be called and tracked
        let calls = await subscriber.finalizeCalls
        XCTAssertEqual(calls, 1)
        XCTAssertNil(mutation)
    }

    func testOnRunFailedCalled() async throws {
        // Given: A subscriber that tracks failures
        let subscriber = MockAgentSubscriber()
        let error = NSError(domain: "test", code: 1)

        // When: Calling onRunFailed
        let params = AgentRunFailureParams(
            error: error,
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onRunFailed(params: params)

        // Then: Should be called and tracked
        let calls = await subscriber.failureCalls
        XCTAssertEqual(calls, 1)
        XCTAssertNil(mutation)
    }

    func testOnMessagesChangedCalled() async throws {
        // Given: A subscriber that tracks message changes
        let subscriber = MockAgentSubscriber()

        // When: Calling onMessagesChanged
        let params = AgentStateChangedParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        await subscriber.onMessagesChanged(params: params)

        // Then: Should be called and tracked
        let calls = await subscriber.messagesChangedCalls
        XCTAssertEqual(calls, 1)
    }

    func testOnStateChangedCalled() async throws {
        // Given: A subscriber that tracks state changes
        let subscriber = MockAgentSubscriber()

        // When: Calling onStateChanged
        let params = AgentStateChangedParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        await subscriber.onStateChanged(params: params)

        // Then: Should be called and tracked
        let calls = await subscriber.stateChangedCalls
        XCTAssertEqual(calls, 1)
    }

    // MARK: - Mutation Tests

    func testMessageMutation() async throws {
        // Given: A subscriber that adds a message
        let subscriber = MutatingSubscriber(
            messagesToAdd: [SystemMessage(id: "added", content: "Added message")]
        )

        // When: Calling onRunInitialized
        let params = AgentSubscriberParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onRunInitialized(params: params)

        // Then: Should return mutation with new messages
        XCTAssertNotNil(mutation)
        XCTAssertEqual(mutation?.messages?.count, 3)
        XCTAssertEqual(mutation?.messages?.last?.id, "added")
        XCTAssertNil(mutation?.state)
        XCTAssertFalse(mutation?.stopPropagation ?? true)
    }

    func testStateMutation() async throws {
        // Given: A subscriber that updates state
        let newState = Data("{\"key\":\"value\"}".utf8)
        let subscriber = MutatingSubscriber(newState: newState)

        // When: Calling onRunInitialized
        let params = AgentSubscriberParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onRunInitialized(params: params)

        // Then: Should return mutation with new state
        XCTAssertNotNil(mutation)
        XCTAssertNil(mutation?.messages)
        XCTAssertEqual(mutation?.state, newState)
        XCTAssertFalse(mutation?.stopPropagation ?? true)
    }

    func testStopPropagation() async throws {
        // Given: A subscriber that stops propagation
        let subscriber = MutatingSubscriber(stopPropagation: true)

        // When: Calling onRunInitialized
        let params = AgentSubscriberParams(
            messages: testMessages,
            state: testState,
            input: testInput
        )
        let mutation = await subscriber.onRunInitialized(params: params)

        // Then: Should return mutation with stopPropagation
        XCTAssertNotNil(mutation)
        XCTAssertNil(mutation?.messages)
        XCTAssertNil(mutation?.state)
        XCTAssertTrue(mutation?.stopPropagation ?? false)
    }

    // MARK: - Mutation Chaining Tests

    func testMutationChaining() async throws {
        // Given: Multiple subscribers that mutate messages
        let subscriber1 = MutatingSubscriber(
            messagesToAdd: [SystemMessage(id: "msg1", content: "First")]
        )
        let subscriber2 = MutatingSubscriber(
            messagesToAdd: [SystemMessage(id: "msg2", content: "Second")]
        )

        // When: Running subscribers with mutation chaining
        let mutation = await runSubscribersWithMutation(
            subscribers: [subscriber1, subscriber2],
            messages: testMessages,
            state: testState
        ) { subscriber, messages, state in
            let params = AgentSubscriberParams(
                messages: messages,
                state: state,
                input: testInput
            )
            return await subscriber.onRunInitialized(params: params)
        }

        // Then: Should have both mutations applied
        XCTAssertNotNil(mutation.messages)
        XCTAssertEqual(mutation.messages?.count, 4) // 2 original + 2 added
        XCTAssertEqual(mutation.messages?[2].id, "msg1")
        XCTAssertEqual(mutation.messages?[3].id, "msg2")
    }

    func testMutationChainingWithState() async throws {
        // Given: Multiple subscribers that mutate state
        let state1 = Data("{\"step\":1}".utf8)
        let state2 = Data("{\"step\":2}".utf8)
        let subscriber1 = MutatingSubscriber(newState: state1)
        let subscriber2 = MutatingSubscriber(newState: state2)

        // When: Running subscribers with mutation chaining
        let mutation = await runSubscribersWithMutation(
            subscribers: [subscriber1, subscriber2],
            messages: testMessages,
            state: testState
        ) { subscriber, messages, state in
            let params = AgentSubscriberParams(
                messages: messages,
                state: state,
                input: testInput
            )
            return await subscriber.onRunInitialized(params: params)
        }

        // Then: Should have last mutation's state
        XCTAssertNotNil(mutation.state)
        XCTAssertEqual(mutation.state, state2)
    }

    func testStopPropagationHaltsChain() async throws {
        // Given: Three subscribers, second stops propagation
        let subscriber1 = MutatingSubscriber(
            messagesToAdd: [SystemMessage(id: "msg1", content: "First")]
        )
        let subscriber2 = MutatingSubscriber(
            messagesToAdd: [SystemMessage(id: "msg2", content: "Second")],
            stopPropagation: true
        )
        let subscriber3 = MutatingSubscriber(
            messagesToAdd: [SystemMessage(id: "msg3", content: "Third")]
        )

        // When: Running subscribers with mutation chaining
        let mutation = await runSubscribersWithMutation(
            subscribers: [subscriber1, subscriber2, subscriber3],
            messages: testMessages,
            state: testState
        ) { subscriber, messages, state in
            let params = AgentSubscriberParams(
                messages: messages,
                state: state,
                input: testInput
            )
            return await subscriber.onRunInitialized(params: params)
        }

        // Then: Should only have first two mutations, not third
        XCTAssertNotNil(mutation.messages)
        XCTAssertEqual(mutation.messages?.count, 4) // 2 original + msg1 + msg2 (no msg3)
        XCTAssertTrue(mutation.stopPropagation)
    }

    // MARK: - Subscription Manager Tests

    func testSubscriberRegistration() async throws {
        // Given: A subscriber manager
        let manager = SubscriberManager()
        let subscriber = MockAgentSubscriber()

        // When: Subscribing
        let id = await manager.subscribe(subscriber)

        // Then: Should be registered
        let subscribers = await manager.allSubscribers()
        XCTAssertEqual(subscribers.count, 1)
        XCTAssertNotNil(id)
    }

    func testSubscriberUnregistration() async throws {
        // Given: A registered subscriber
        let manager = SubscriberManager()
        let subscriber = MockAgentSubscriber()
        let id = await manager.subscribe(subscriber)

        // When: Unsubscribing
        await manager.unsubscribe(id)

        // Then: Should be removed
        let subscribers = await manager.allSubscribers()
        XCTAssertEqual(subscribers.count, 0)
    }

    func testMultipleSubscribers() async throws {
        // Given: Multiple subscribers
        let manager = SubscriberManager()
        let subscriber1 = MockAgentSubscriber()
        let subscriber2 = MockAgentSubscriber()
        let subscriber3 = MockAgentSubscriber()

        // When: Subscribing all
        _ = await manager.subscribe(subscriber1)
        _ = await manager.subscribe(subscriber2)
        _ = await manager.subscribe(subscriber3)

        // Then: All should be registered
        let subscribers = await manager.allSubscribers()
        XCTAssertEqual(subscribers.count, 3)
    }

    func testSubscriberExecutionOrderMatchesRegistration() async throws {
        // Given: A subscriber manager and an ordered recorder
        let manager = SubscriberManager()

        actor CallOrderTracker {
            var order: [Int] = []
            func record(_ index: Int) { order.append(index) }
        }
        let tracker = CallOrderTracker()

        struct IndexedSubscriber: AgentSubscriber {
            let index: Int
            let tracker: CallOrderTracker

            func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
                await tracker.record(index)
                return nil
            }
        }

        let testInput = try RunAgentInput.builder()
            .threadId("order-thread")
            .runId("order-run")
            .build()

        // When: 5 subscribers registered in order 0..4
        for i in 0 ..< 5 {
            _ = await manager.subscribe(IndexedSubscriber(index: i, tracker: tracker))
        }

        // Drive each subscriber in allSubscribers() order
        let params = AgentSubscriberParams(messages: [], state: Data("{}".utf8), input: testInput)
        for sub in await manager.allSubscribers() {
            _ = await sub.onRunInitialized(params: params)
        }

        // Then: callbacks must arrive in registration order, not dict iteration order
        let callOrder = await tracker.order
        XCTAssertEqual(callOrder, [0, 1, 2, 3, 4])
    }

    func testUnsubscribePreservesRemainingOrder() async throws {
        // Given: 4 subscribers registered in order 0..3
        let manager = SubscriberManager()

        actor CallOrderTracker {
            var order: [Int] = []
            func record(_ index: Int) { order.append(index) }
        }
        let tracker = CallOrderTracker()

        struct IndexedSubscriber: AgentSubscriber {
            let index: Int
            let tracker: CallOrderTracker
            func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
                await tracker.record(index)
                return nil
            }
        }

        let testInput = try RunAgentInput.builder()
            .threadId("t").runId("r").build()

        var ids: [UUID] = []
        for i in 0 ..< 4 {
            let id = await manager.subscribe(IndexedSubscriber(index: i, tracker: tracker))
            ids.append(id)
        }

        // When: unsubscribe the second subscriber (index 1)
        await manager.unsubscribe(ids[1])

        let params = AgentSubscriberParams(messages: [], state: Data("{}".utf8), input: testInput)
        for sub in await manager.allSubscribers() {
            _ = await sub.onRunInitialized(params: params)
        }

        // Then: remaining subscribers fire in insertion order: [0, 2, 3]
        let callOrder = await tracker.order
        XCTAssertEqual(callOrder, [0, 2, 3])
    }

    func testSubscriptionHandle() async throws {
        // Given: A subscription with tracked state
        actor UnsubscribeTracker {
            var unsubscribed = false
            func markUnsubscribed() {
                unsubscribed = true
            }
        }

        let tracker = UnsubscribeTracker()
        let subscription = DefaultAgentSubscription {
            await tracker.markUnsubscribed()
        }

        // When: Unsubscribing
        await subscription.unsubscribe()

        // Then: Should call unsubscribe closure
        let wasUnsubscribed = await tracker.unsubscribed
        XCTAssertTrue(wasUnsubscribed)
    }

    func testSubscriptionIdempotence() async throws {
        // Given: A subscription with tracked call count
        actor CallTracker {
            var callCount = 0
            func increment() {
                callCount += 1
            }
        }

        let tracker = CallTracker()
        let subscription = DefaultAgentSubscription {
            await tracker.increment()
        }
        await subscription.unsubscribe()

        // When: Unsubscribing again
        await subscription.unsubscribe()

        // Then: Should only call once
        let calls = await tracker.callCount
        XCTAssertEqual(calls, 1)
    }
}

// MARK: - Mock Subscribers

private actor MockAgentSubscriber: AgentSubscriber {
    var initializeCalls = 0
    var eventCalls = 0
    var finalizeCalls = 0
    var failureCalls = 0
    var messagesChangedCalls = 0
    var stateChangedCalls = 0

    func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
        initializeCalls += 1
        return nil
    }

    func onEvent(params: AgentEventParams) async -> AgentStateMutation? {
        eventCalls += 1
        return nil
    }

    func onRunFinalized(params: AgentSubscriberParams) async -> AgentStateMutation? {
        finalizeCalls += 1
        return nil
    }

    func onRunFailed(params: AgentRunFailureParams) async -> AgentStateMutation? {
        failureCalls += 1
        return nil
    }

    func onMessagesChanged(params: AgentStateChangedParams) async {
        messagesChangedCalls += 1
    }

    func onStateChanged(params: AgentStateChangedParams) async {
        stateChangedCalls += 1
    }
}

private struct MutatingSubscriber: AgentSubscriber {
    let messagesToAdd: [any Message]?
    let newState: State?
    let stopPropagation: Bool

    init(
        messagesToAdd: [any Message]? = nil,
        newState: State? = nil,
        stopPropagation: Bool = false
    ) {
        self.messagesToAdd = messagesToAdd
        self.newState = newState
        self.stopPropagation = stopPropagation
    }

    func onRunInitialized(params: AgentSubscriberParams) async -> AgentStateMutation? {
        var updatedMessages: [any Message]?
        if let toAdd = messagesToAdd {
            updatedMessages = params.messages + toAdd
        }

        return AgentStateMutation(
            messages: updatedMessages,
            state: newState,
            stopPropagation: stopPropagation
        )
    }
}
