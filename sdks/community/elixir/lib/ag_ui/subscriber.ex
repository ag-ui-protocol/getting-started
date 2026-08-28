defmodule AgUI.Subscriber do
  @moduledoc """
  Subscriber callbacks for observing events and mutating state.

  Subscribers allow you to observe the event stream and optionally mutate
  the session state or stop event propagation. This is useful for:

  - Reacting to specific events (e.g., tool calls, state changes)
  - Implementing custom business logic
  - Transforming or filtering events
  - Building higher-level abstractions

  ## Behavior

  A subscriber implements the `on_event/2` callback which is called for
  each event in the stream. The callback can return:

  - `:ok` - Event is processed normally
  - `{:mutate, mutation}` - Apply mutations to the session state

  ## Mutations

  Mutations can include:

  - `:messages` - Replace the messages list
  - `:state` - Replace the state map
  - `:stop_propagation` - If true, the event is not yielded to downstream consumers

  ## Example

      defmodule MyApp.ToolCallSubscriber do
        @behaviour AgUI.Subscriber

        @impl true
        def on_event(%AgUI.Events.ToolCallResult{} = event, session) do
          # Log tool results
          IO.puts("Tool call \#{event.tool_call_id} returned: \#{event.content}")
          :ok
        end

        def on_event(%AgUI.Events.StateSnapshot{snapshot: state}, _session) do
          # Transform state on snapshots
          new_state = Map.put(state, "last_updated", DateTime.utc_now())
          {:mutate, %{state: new_state}}
        end

        def on_event(_event, _session), do: :ok
      end

  ## Specialized Callbacks

  In addition to `on_event/2`, subscribers can implement specialized callbacks
  that provide additional context:

  - `on_run_started/2` - Called on RUN_STARTED
  - `on_run_finished/2` - Called on RUN_FINISHED
  - `on_run_error/2` - Called on RUN_ERROR
  - `on_text_message_content/3` - Called on TEXT_MESSAGE_CONTENT with full buffer
  - `on_tool_call_args/3` - Called on TOOL_CALL_ARGS with full buffer
  - `on_state_changed/2` - Called after state is updated
  - `on_messages_changed/2` - Called after messages list changes

  These callbacks are optional and will be called if defined.

  """

  alias AgUI.Session
  alias AgUI.Events
  alias AgUI.Reducer

  @typedoc """
  A mutation to apply to the session state.

  - `:messages` - Replace the messages list
  - `:state` - Replace the state map
  - `:stop_propagation` - If true, the event is not yielded downstream
  """
  @type mutation :: %{
          optional(:messages) => [AgUI.Types.Message.t()],
          optional(:state) => map(),
          optional(:stop_propagation) => boolean()
        }

  @typedoc """
  The result of an event callback.

  - `:ok` - Process the event normally
  - `{:mutate, mutation}` - Apply mutations before processing
  """
  @type callback_result :: :ok | {:mutate, mutation()}

  @typedoc """
  A subscriber can be either a module implementing the behaviour,
  or a wrapper created by `from_handlers/1` or `chain/1`.
  """
  @type subscriber :: module() | %__MODULE__.HandlerWrapper{} | %__MODULE__.ChainWrapper{}

  @doc """
  Called for each event in the stream.

  Return `:ok` to process normally, or `{:mutate, mutation}` to apply changes.
  """
  @callback on_event(event :: Events.t(), session :: Session.t()) :: callback_result()

  @doc """
  Called when a run starts.
  """
  @callback on_run_started(event :: Events.RunStarted.t(), session :: Session.t()) ::
              callback_result()

  @doc """
  Called when a run finishes successfully.
  """
  @callback on_run_finished(event :: Events.RunFinished.t(), session :: Session.t()) ::
              callback_result()

  @doc """
  Called when a run fails with an error.
  """
  @callback on_run_error(event :: Events.RunError.t(), session :: Session.t()) ::
              callback_result()

  @doc """
  Called for each text message content chunk.

  Receives the event, the full accumulated buffer content, and the session.
  """
  @callback on_text_message_content(
              event :: Events.TextMessageContent.t(),
              buffer :: String.t(),
              session :: Session.t()
            ) :: callback_result()

  @doc """
  Called for each tool call args chunk.

  Receives the event, the full accumulated args buffer, and the session.
  """
  @callback on_tool_call_args(
              event :: Events.ToolCallArgs.t(),
              buffer :: String.t(),
              session :: Session.t()
            ) :: callback_result()

  @doc """
  Called after the session state is updated.
  """
  @callback on_state_changed(new_state :: map(), session :: Session.t()) :: callback_result()

  @doc """
  Called after the messages list changes.
  """
  @callback on_messages_changed(
              new_messages :: [AgUI.Types.Message.t()],
              session :: Session.t()
            ) :: callback_result()

  @optional_callbacks [
    on_run_started: 2,
    on_run_finished: 2,
    on_run_error: 2,
    on_text_message_content: 3,
    on_tool_call_args: 3,
    on_state_changed: 2,
    on_messages_changed: 2
  ]

  # Wrapper struct for handler-based subscribers
  defmodule HandlerWrapper do
    @moduledoc false
    defstruct [:handlers]
  end

  # Wrapper struct for chained subscribers
  defmodule ChainWrapper do
    @moduledoc false
    defstruct [:subscribers]
  end

  @doc """
  Applies a subscriber to an event stream.

  Returns a transformed stream and processes events through the subscriber.

  ## Parameters

  - `stream` - The event stream to observe
  - `subscriber` - The subscriber (module, handler wrapper, or chain wrapper)
  - `initial_session` - The initial session state

  ## Returns

  A new stream that yields events after subscriber processing.

  ## Example

      stream = HttpAgent.stream(agent, input)
      session = Session.new()

      observed_stream = AgUI.Subscriber.observe(stream, MySubscriber, session)

      Enum.each(observed_stream, fn event ->
        # Process observed events
      end)

  """
  @spec observe(Enumerable.t(), subscriber(), Session.t()) :: Enumerable.t()
  def observe(stream, subscriber, initial_session) do
    Stream.transform(stream, initial_session, fn event, session ->
      # First, call the generic on_event callback
      result = call_on_event(subscriber, event, session)

      # Apply any mutations
      {session, stop_propagation?} = handle_callback_result(session, result)

      # Call specialized callbacks if defined (only for module subscribers)
      session = call_specialized_callbacks(subscriber, event, session)

      # Apply the event to get new session state
      new_session = Reducer.apply(session, event)

      # Call post-update callbacks (only for module subscribers)
      new_session = call_post_update_callbacks(subscriber, event, session, new_session)

      if stop_propagation? do
        {[], new_session}
      else
        {[event], new_session}
      end
    end)
  end

  @doc """
  Observes a stream with a subscriber and also returns the final session.

  This is useful when you need both the processed events and the final state.

  ## Returns

  `{events_list, final_session}`

  ## Example

      {events, final_session} = AgUI.Subscriber.observe_with_state(stream, subscriber, session)

  """
  @spec observe_with_state(Enumerable.t(), subscriber(), Session.t()) ::
          {[Events.t()], Session.t()}
  def observe_with_state(stream, subscriber, initial_session) do
    {events_reversed, final_session} =
      Enum.reduce(stream, {[], initial_session}, fn event, {events, session} ->
        result = call_on_event(subscriber, event, session)
        {session, stop_propagation?} = handle_callback_result(session, result)

        session = call_specialized_callbacks(subscriber, event, session)
        new_session = Reducer.apply(session, event)
        new_session = call_post_update_callbacks(subscriber, event, session, new_session)

        if stop_propagation? do
          {events, new_session}
        else
          {[event | events], new_session}
        end
      end)

    {Enum.reverse(events_reversed), final_session}
  end

  @doc """
  Creates a subscriber from a map of event type to handler functions.

  This is useful for simple subscribers that only need to handle specific events.

  ## Example

      subscriber = AgUI.Subscriber.from_handlers(%{
        run_started: fn event, session ->
          IO.puts("Run started: \#{event.run_id}")
          :ok
        end,
        tool_call_result: fn event, session ->
          IO.puts("Tool result: \#{event.content}")
          :ok
        end
      })

  """
  @spec from_handlers(%{atom() => (Events.t(), Session.t() -> callback_result())}) :: subscriber()
  def from_handlers(handlers) when is_map(handlers) do
    %HandlerWrapper{handlers: handlers}
  end

  @doc """
  Chains multiple subscribers together.

  Events pass through each subscriber in order. Mutations from earlier
  subscribers are visible to later ones.

  ## Example

      chained = AgUI.Subscriber.chain([Subscriber1, Subscriber2])
      stream = AgUI.Subscriber.observe(events, chained, session)

  """
  @spec chain([subscriber()]) :: subscriber()
  def chain(subscribers) when is_list(subscribers) do
    %ChainWrapper{subscribers: subscribers}
  end

  @doc """
  Applies a mutation to a session.

  This is a helper function used internally and by chained subscribers.
  """
  @spec apply_mutation(Session.t(), mutation()) :: Session.t()
  def apply_mutation(session, mutation) do
    session
    |> maybe_update(:messages, mutation[:messages])
    |> maybe_update(:state, mutation[:state])
  end

  # Private helpers

  # Call on_event for different subscriber types
  defp call_on_event(%HandlerWrapper{handlers: handlers}, event, session) do
    case Map.get(handlers, event.type) do
      nil -> :ok
      handler -> handler.(event, session)
    end
  end

  defp call_on_event(%ChainWrapper{subscribers: subscribers}, event, session) do
    Enum.reduce_while(subscribers, {:ok, session}, fn subscriber, {_result, session} ->
      case call_on_event(subscriber, event, session) do
        :ok ->
          {:cont, {:ok, session}}

        {:mutate, mutation} ->
          new_session = apply_mutation(session, mutation)

          if mutation[:stop_propagation] do
            {:halt, {:mutate, mutation}}
          else
            {:cont, {:ok, new_session}}
          end
      end
    end)
    |> case do
      {:ok, _session} -> :ok
      {:mutate, mutation} -> {:mutate, mutation}
    end
  end

  defp call_on_event(module, event, session) when is_atom(module) do
    module.on_event(event, session)
  end

  defp handle_callback_result(session, :ok) do
    {session, false}
  end

  defp handle_callback_result(session, {:mutate, mutation}) do
    new_session = apply_mutation(session, mutation)
    stop = mutation[:stop_propagation] == true
    {new_session, stop}
  end

  defp maybe_update(session, _field, nil), do: session
  defp maybe_update(session, field, value), do: Map.put(session, field, value)

  # Specialized callbacks only work with module subscribers
  defp call_specialized_callbacks(module, event, session) when is_atom(module) do
    case event do
      %Events.RunStarted{} ->
        call_if_defined(module, :on_run_started, [event, session], session)

      %Events.RunFinished{} ->
        call_if_defined(module, :on_run_finished, [event, session], session)

      %Events.RunError{} ->
        call_if_defined(module, :on_run_error, [event, session], session)

      %Events.TextMessageContent{message_id: id} ->
        buffer = get_in(session.text_buffers, [id, :content]) || ""
        call_if_defined(module, :on_text_message_content, [event, buffer, session], session)

      %Events.ToolCallArgs{tool_call_id: id} ->
        buffer = get_in(session.tool_buffers, [id, :args]) || ""
        call_if_defined(module, :on_tool_call_args, [event, buffer, session], session)

      _ ->
        session
    end
  end

  # Wrapper types don't support specialized callbacks
  defp call_specialized_callbacks(_wrapper, _event, session), do: session

  # Post-update callbacks only work with module subscribers
  defp call_post_update_callbacks(module, event, old_session, new_session) when is_atom(module) do
    cond do
      # State changed
      event.type in [:state_snapshot, :state_delta] and old_session.state != new_session.state ->
        call_if_defined(
          module,
          :on_state_changed,
          [new_session.state, new_session],
          new_session
        )

      # Messages changed
      old_session.messages != new_session.messages ->
        call_if_defined(
          module,
          :on_messages_changed,
          [new_session.messages, new_session],
          new_session
        )

      true ->
        new_session
    end
  end

  # Wrapper types don't support post-update callbacks
  defp call_post_update_callbacks(_wrapper, _event, _old_session, new_session), do: new_session

  defp call_if_defined(subscriber, callback, args, session) do
    if function_exported?(subscriber, callback, length(args)) do
      case Kernel.apply(subscriber, callback, args) do
        :ok -> session
        {:mutate, mutation} -> apply_mutation(session, mutation)
      end
    else
      session
    end
  end
end
