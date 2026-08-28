defmodule AgUI.SubscriberTest do
  use ExUnit.Case, async: true

  alias AgUI.Subscriber
  alias AgUI.Session
  alias AgUI.Events
  alias AgUI.Types.Message

  # Basic subscriber that tracks events
  defmodule TrackingSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(event, _session) do
      send(self(), {:event, event.type})
      :ok
    end
  end

  # Subscriber that mutates state
  defmodule StateMutatingSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(%Events.StateSnapshot{}, _session) do
      {:mutate, %{state: %{"mutated" => true}}}
    end

    def on_event(_event, _session), do: :ok
  end

  # Subscriber that stops propagation
  defmodule FilteringSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(%Events.ThinkingStart{}, _session) do
      {:mutate, %{stop_propagation: true}}
    end

    def on_event(%Events.ThinkingEnd{}, _session) do
      {:mutate, %{stop_propagation: true}}
    end

    def on_event(_event, _session), do: :ok
  end

  # Subscriber that mutates messages
  defmodule MessageMutatingSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(%Events.TextMessageEnd{message_id: id}, session) do
      new_messages =
        Enum.map(session.messages, fn
          %Message.Assistant{id: ^id} = msg ->
            %{msg | content: msg.content <> " [processed]"}

          msg ->
            msg
        end)

      {:mutate, %{messages: new_messages}}
    end

    def on_event(_event, _session), do: :ok
  end

  # Subscriber with specialized callbacks
  defmodule SpecializedSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(_event, _session), do: :ok

    @impl true
    def on_run_started(event, _session) do
      send(self(), {:run_started, event.run_id})
      :ok
    end

    @impl true
    def on_run_finished(_event, _session) do
      send(self(), :run_finished)
      :ok
    end

    @impl true
    def on_run_error(event, _session) do
      send(self(), {:run_error, event.message})
      :ok
    end

    @impl true
    def on_text_message_content(_event, buffer, _session) do
      send(self(), {:text_buffer, buffer})
      :ok
    end

    @impl true
    def on_tool_call_args(_event, buffer, _session) do
      send(self(), {:tool_buffer, buffer})
      :ok
    end

    @impl true
    def on_state_changed(new_state, _session) do
      send(self(), {:state_changed, new_state})
      :ok
    end

    @impl true
    def on_messages_changed(new_messages, _session) do
      send(self(), {:messages_changed, length(new_messages)})
      :ok
    end
  end

  defmodule MutatingSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(%Events.RunStarted{}, _session) do
      {:mutate, %{state: %{"mutated" => true}}}
    end

    def on_event(_event, _session), do: :ok
  end

  defmodule ObservingSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(%Events.RunStarted{}, session) do
      send(self(), {:state_seen, session.state})
      :ok
    end

    def on_event(_event, _session), do: :ok
  end

  defmodule StopSubscriber do
    @behaviour AgUI.Subscriber

    @impl true
    def on_event(%Events.RunStarted{}, _session) do
      {:mutate, %{stop_propagation: true}}
    end

    def on_event(_event, _session), do: :ok
  end

  describe "observe/3" do
    test "passes events through subscriber" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      result = Subscriber.observe(events, TrackingSubscriber, session) |> Enum.to_list()

      assert length(result) == 2
      assert_received {:event, :run_started}
      assert_received {:event, :run_finished}
    end

    test "subscriber can mutate state" do
      events = [
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"original" => true}}
      ]

      session = Session.new()

      {result, final_session} =
        Subscriber.observe_with_state(events, StateMutatingSubscriber, session)

      assert length(result) == 1
      # State was mutated by subscriber, then event applied
      # The mutation replaces state, then StateSnapshot also replaces state
      assert final_session.state == %{"original" => true}
    end

    test "subscriber can stop propagation" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.ThinkingStart{type: :thinking_start},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "hi"},
        %Events.ThinkingEnd{type: :thinking_end},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      result = Subscriber.observe(events, FilteringSubscriber, session) |> Enum.to_list()

      # ThinkingStart and ThinkingEnd are filtered out
      assert length(result) == 3

      types = Enum.map(result, & &1.type)
      assert :run_started in types
      assert :text_message_content in types
      assert :run_finished in types
      refute :thinking_start in types
      refute :thinking_end in types
    end

    test "applies reducer after subscriber processing" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()

      {_result, final_session} =
        Subscriber.observe_with_state(events, TrackingSubscriber, session)

      assert final_session.status == :finished
      assert length(final_session.messages) == 1
      assert hd(final_session.messages).content == "Hello"
    end
  end

  describe "observe_with_state/3" do
    test "returns events and final session" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"count" => 1}},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      {result, final_session} = Subscriber.observe_with_state(events, TrackingSubscriber, session)

      assert length(result) == 3
      assert final_session.status == :finished
      assert final_session.state == %{"count" => 1}
    end
  end

  describe "specialized callbacks" do
    test "on_run_started is called" do
      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "test-run"}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      assert_received {:run_started, "test-run"}
    end

    test "on_run_finished is called" do
      events = [
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      assert_received :run_finished
    end

    test "on_run_error is called" do
      events = [
        %Events.RunError{type: :run_error, message: "Something failed"}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      assert_received {:run_error, "Something failed"}
    end

    test "on_text_message_content is called with buffer" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "Hello"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: " world"}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      # First content event has empty buffer (content not yet applied)
      assert_received {:text_buffer, ""}
      # Second content event has first delta in buffer
      assert_received {:text_buffer, "Hello"}
    end

    test "on_tool_call_args is called with buffer" do
      events = [
        %Events.ToolCallStart{
          type: :tool_call_start,
          tool_call_id: "tc1",
          tool_call_name: "search",
          parent_message_id: nil
        },
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "tc1", delta: "{\"q\":"},
        %Events.ToolCallArgs{type: :tool_call_args, tool_call_id: "tc1", delta: "\"test\"}"}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      assert_received {:tool_buffer, ""}
      assert_received {:tool_buffer, "{\"q\":"}
    end

    test "on_state_changed is called after state update" do
      events = [
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"count" => 42}}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      assert_received {:state_changed, %{"count" => 42}}
    end

    test "on_messages_changed is called after message update" do
      events = [
        %Events.TextMessageStart{type: :text_message_start, message_id: "m1", role: "assistant"},
        %Events.TextMessageEnd{type: :text_message_end, message_id: "m1"}
      ]

      session = Session.new()
      Subscriber.observe(events, SpecializedSubscriber, session) |> Enum.to_list()

      # on_messages_changed called when message is finalized
      assert_received {:messages_changed, 1}
    end
  end

  describe "from_handlers/1" do
    test "creates subscriber from handler map" do
      subscriber =
        Subscriber.from_handlers(%{
          run_started: fn event, _session ->
            send(self(), {:started, event.run_id})
            :ok
          end,
          run_finished: fn _event, _session ->
            send(self(), :finished)
            :ok
          end
        })

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "handler-test"},
        %Events.TextMessageContent{type: :text_message_content, message_id: "m1", delta: "hi"},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      Subscriber.observe(events, subscriber, session) |> Enum.to_list()

      assert_received {:started, "handler-test"}
      assert_received :finished
    end

    test "handler can mutate state" do
      subscriber =
        Subscriber.from_handlers(%{
          state_snapshot: fn _event, _session ->
            {:mutate, %{state: %{"custom" => true}}}
          end
        })

      events = [
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"original" => true}}
      ]

      session = Session.new()
      {_result, final_session} = Subscriber.observe_with_state(events, subscriber, session)

      # Mutation happens before event is applied, then event overwrites
      assert final_session.state == %{"original" => true}
    end

    test "handler can stop propagation" do
      subscriber =
        Subscriber.from_handlers(%{
          thinking_start: fn _event, _session ->
            {:mutate, %{stop_propagation: true}}
          end
        })

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"},
        %Events.ThinkingStart{type: :thinking_start},
        %Events.RunFinished{type: :run_finished, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      result = Subscriber.observe(events, subscriber, session) |> Enum.to_list()

      assert length(result) == 2
      types = Enum.map(result, & &1.type)
      refute :thinking_start in types
    end
  end

  describe "chain/1" do
    test "chains multiple subscribers" do
      s1 =
        Subscriber.from_handlers(%{
          run_started: fn _event, _session ->
            send(self(), {:s1, :started})
            :ok
          end
        })

      s2 =
        Subscriber.from_handlers(%{
          run_started: fn _event, _session ->
            send(self(), {:s2, :started})
            :ok
          end
        })

      chained = Subscriber.chain([s1, s2])

      events = [
        %Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}
      ]

      session = Session.new()
      Subscriber.observe(events, chained, session) |> Enum.to_list()

      assert_received {:s1, :started}
      assert_received {:s2, :started}
    end

    test "chained subscribers can stop propagation" do
      s1 =
        Subscriber.from_handlers(%{
          thinking_start: fn _event, _session ->
            {:mutate, %{stop_propagation: true}}
          end
        })

      s2 =
        Subscriber.from_handlers(%{
          thinking_start: fn _event, _session ->
            # This should not be called if s1 stops propagation
            send(self(), :s2_called)
            :ok
          end
        })

      chained = Subscriber.chain([s1, s2])

      events = [
        %Events.ThinkingStart{type: :thinking_start}
      ]

      session = Session.new()
      result = Subscriber.observe(events, chained, session) |> Enum.to_list()

      assert result == []
      refute_received :s2_called
    end

    test "mutations from earlier subscribers are visible to later ones" do
      s1 =
        Subscriber.from_handlers(%{
          state_snapshot: fn _event, session ->
            # Mutate state
            {:mutate, %{state: Map.put(session.state, "s1", true)}}
          end
        })

      s2 =
        Subscriber.from_handlers(%{
          state_snapshot: fn _event, session ->
            # Should see s1's mutation
            send(self(), {:s2_sees_state, session.state})
            :ok
          end
        })

      chained = Subscriber.chain([s1, s2])

      events = [
        %Events.StateSnapshot{type: :state_snapshot, snapshot: %{"original" => true}}
      ]

      session = Session.new()
      Subscriber.observe(events, chained, session) |> Enum.to_list()

      assert_received {:s2_sees_state, state}
      assert state["s1"] == true
    end
  end

  describe "apply_mutation/2" do
    test "applies messages mutation" do
      session = Session.new()
      message = %Message.User{id: "m1", role: :user, content: "Hello"}
      mutation = %{messages: [message]}

      new_session = Subscriber.apply_mutation(session, mutation)

      assert new_session.messages == [message]
    end

    test "applies state mutation" do
      session = Session.new()
      mutation = %{state: %{"key" => "value"}}

      new_session = Subscriber.apply_mutation(session, mutation)

      assert new_session.state == %{"key" => "value"}
    end

    test "applies multiple mutations" do
      session = Session.new()
      message = %Message.User{id: "m1", role: :user, content: "Hello"}

      mutation = %{
        messages: [message],
        state: %{"key" => "value"}
      }

      new_session = Subscriber.apply_mutation(session, mutation)

      assert new_session.messages == [message]
      assert new_session.state == %{"key" => "value"}
    end

    test "ignores nil values" do
      session = %Session{
        messages: [%Message.User{id: "m1", role: :user, content: "Original"}],
        state: %{"original" => true}
      }

      mutation = %{messages: nil, state: nil}

      new_session = Subscriber.apply_mutation(session, mutation)

      # Nothing should change
      assert new_session.messages == session.messages
      assert new_session.state == session.state
    end
  end

  describe "subscriber chaining semantics" do
    test "mutations from earlier subscribers are visible to later ones" do
      events = [%Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}]

      session = Session.new()
      chained = Subscriber.chain([MutatingSubscriber, ObservingSubscriber])

      Subscriber.observe(events, chained, session) |> Enum.to_list()

      assert_received {:state_seen, %{"mutated" => true}}
    end

    test "stop_propagation halts later subscribers and event emission" do
      events = [%Events.RunStarted{type: :run_started, thread_id: "t1", run_id: "r1"}]

      session = Session.new()
      chained = Subscriber.chain([StopSubscriber, ObservingSubscriber])

      result = Subscriber.observe(events, chained, session) |> Enum.to_list()

      assert result == []
      refute_received {:state_seen, _}
    end
  end
end
