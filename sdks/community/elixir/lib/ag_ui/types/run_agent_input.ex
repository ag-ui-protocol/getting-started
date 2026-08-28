defmodule AgUI.Types.RunAgentInput do
  @moduledoc """
  Input parameters for executing an agent run.

  This is the main payload sent to an AG-UI agent endpoint via HTTP POST.
  It contains the conversation context, available tools, and current state.

  ## Wire Format

      {
        "threadId": "thread-123",
        "runId": "run-456",
        "parentRunId": "run-455",
        "state": {"counter": 0},
        "messages": [...],
        "tools": [...],
        "context": [...],
        "forwardedProps": {"customField": "value"}
      }

  ## Required Fields

  - `thread_id` - Identifies the conversation thread
  - `run_id` - Unique identifier for this run

  ## Optional Fields

  - `parent_run_id` - For branching/time travel, references the spawning run
  - `state` - Current application state (shared between agent and UI)
  - `messages` - Conversation history
  - `tools` - Available tools the agent can call
  - `context` - Additional contextual information
  - `forwarded_props` - Custom properties passed through to the agent

  """

  alias AgUI.Types.{Message, Tool, Context}

  @type t :: %__MODULE__{
          thread_id: String.t(),
          run_id: String.t(),
          parent_run_id: String.t() | nil,
          state: term(),
          messages: [Message.t()],
          tools: [Tool.t()],
          context: [Context.t()],
          forwarded_props: map()
        }

  @enforce_keys [:thread_id, :run_id]
  defstruct [
    :thread_id,
    :run_id,
    :parent_run_id,
    state: %{},
    messages: [],
    tools: [],
    context: [],
    forwarded_props: %{}
  ]

  @doc """
  Creates a RunAgentInput from a wire format map.

  ## Examples

      iex> AgUI.Types.RunAgentInput.from_map(%{
      ...>   "threadId" => "t1",
      ...>   "runId" => "r1",
      ...>   "state" => %{"count" => 0}
      ...> })
      {:ok, %AgUI.Types.RunAgentInput{
        thread_id: "t1",
        run_id: "r1",
        state: %{"count" => 0},
        messages: [],
        tools: [],
        context: [],
        forwarded_props: %{}
      }}

  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"threadId" => thread_id, "runId" => run_id} = map)
      when is_binary(thread_id) and is_binary(run_id) do
    with {:ok, messages} <- parse_messages(map["messages"]),
         {:ok, tools} <- parse_tools(map["tools"]),
         {:ok, context} <- parse_context(map["context"]) do
      {:ok,
       %__MODULE__{
         thread_id: thread_id,
         run_id: run_id,
         parent_run_id: map["parentRunId"],
         state: Map.get(map, "state", %{}),
         messages: messages,
         tools: tools,
         context: context,
         forwarded_props: map["forwardedProps"] || %{}
       }}
    end
  end

  def from_map(%{"threadId" => _, "runId" => _}) do
    {:error, :invalid_types}
  end

  def from_map(map) when is_map(map) do
    cond do
      not Map.has_key?(map, "threadId") -> {:error, :missing_thread_id}
      not Map.has_key?(map, "runId") -> {:error, :missing_run_id}
      true -> {:error, :missing_required_fields}
    end
  end

  def from_map(_), do: {:error, :invalid_input}

  defp parse_messages(nil), do: {:ok, []}

  defp parse_messages(messages) when is_list(messages) do
    results = Enum.map(messages, &Message.from_map/1)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil -> {:ok, Enum.map(results, fn {:ok, m} -> m end)}
      error -> error
    end
  end

  defp parse_messages(_), do: {:error, :invalid_messages}

  defp parse_tools(nil), do: {:ok, []}

  defp parse_tools(tools) when is_list(tools) do
    results = Enum.map(tools, &Tool.from_map/1)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil -> {:ok, Enum.map(results, fn {:ok, t} -> t end)}
      error -> error
    end
  end

  defp parse_tools(_), do: {:error, :invalid_tools}

  defp parse_context(nil), do: {:ok, []}

  defp parse_context(context) when is_list(context) do
    results = Enum.map(context, &Context.from_map/1)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil -> {:ok, Enum.map(results, fn {:ok, c} -> c end)}
      error -> error
    end
  end

  defp parse_context(_), do: {:error, :invalid_context}

  @doc """
  Converts a RunAgentInput to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = input) do
    base = %{
      "threadId" => input.thread_id,
      "runId" => input.run_id,
      "parentRunId" => input.parent_run_id,
      "state" => input.state,
      "messages" => Enum.map(input.messages, &Message.to_map/1),
      "tools" => Enum.map(input.tools, &Tool.to_map/1),
      "context" => Enum.map(input.context, &Context.to_map/1),
      "forwardedProps" => input.forwarded_props
    }

    # Remove nil parentRunId but keep empty arrays and maps
    if is_nil(base["parentRunId"]) do
      Map.delete(base, "parentRunId")
    else
      base
    end
  end

  @doc """
  Creates a new RunAgentInput with required fields.

  ## Examples

      iex> AgUI.Types.RunAgentInput.new("thread-1", "run-1")
      %AgUI.Types.RunAgentInput{thread_id: "thread-1", run_id: "run-1"}

  """
  @spec new(String.t(), String.t(), keyword()) :: t()
  def new(thread_id, run_id, opts \\ []) do
    %__MODULE__{
      thread_id: thread_id,
      run_id: run_id,
      parent_run_id: opts[:parent_run_id],
      state: Keyword.get(opts, :state, %{}),
      messages: Keyword.get(opts, :messages, []),
      tools: Keyword.get(opts, :tools, []),
      context: Keyword.get(opts, :context, []),
      forwarded_props: Keyword.get(opts, :forwarded_props, %{})
    }
  end

  @doc """
  Adds a message to the input.
  """
  @spec add_message(t(), Message.t()) :: t()
  def add_message(%__MODULE__{} = input, message) do
    %{input | messages: input.messages ++ [message]}
  end

  @doc """
  Adds a tool to the input.
  """
  @spec add_tool(t(), Tool.t()) :: t()
  def add_tool(%__MODULE__{} = input, tool) do
    %{input | tools: input.tools ++ [tool]}
  end

  @doc """
  Updates the state.
  """
  @spec put_state(t(), term()) :: t()
  def put_state(%__MODULE__{} = input, state) do
    %{input | state: state}
  end

  @doc """
  Merges into the state.
  """
  @spec merge_state(t(), map()) :: t()
  def merge_state(%__MODULE__{} = input, state) when is_map(state) do
    %{input | state: Map.merge(input.state, state)}
  end
end
