defmodule AgUI.Middleware.FilterToolCalls do
  @moduledoc """
  Middleware that filters tool-call related events by allowlist or blocklist.

  When a tool call is filtered, all TOOL_CALL_* events for that tool call id
  are dropped from the stream.

  ## Options

  - `:allow` - list of tool names to allow (others are filtered)
  - `:block` - list of tool names to block

  If both are provided, `:allow` takes precedence.
  """

  @behaviour AgUI.Middleware

  alias AgUI.Events
  alias AgUI.Types.RunAgentInput

  @type option :: {:allow, [String.t()]} | {:block, [String.t()]}

  @doc """
  Creates a configured filter middleware.

  ## Examples

      middleware = AgUI.Middleware.FilterToolCalls.new(allow: ["weather"])
      runner = AgUI.Middleware.chain([middleware], final_runner)
      runner.(input) |> Enum.to_list()
  """
  @spec new([option()]) :: AgUI.Middleware.middleware()
  def new(opts \\ []) do
    allow = Keyword.get(opts, :allow)
    block = Keyword.get(opts, :block)

    {allow_set, block_set} = {to_set(allow), to_set(block)}

    %{
      allow: allow_set,
      block: block_set
    }
    |> build_wrapper()
  end

  @impl true
  @spec call(RunAgentInput.t(), AgUI.Middleware.next()) :: Enumerable.t()
  def call(input, next) do
    stream = next.(input)
    filter_stream(stream, nil, nil)
  end

  defp build_wrapper(state) do
    AgUI.Middleware.from_function(fn input, next ->
      stream = next.(input)
      filter_stream(stream, state.allow, state.block)
    end)
  end

  defp to_set(nil), do: nil
  defp to_set(list) when is_list(list), do: MapSet.new(list)

  defp filter_stream(stream, allow, block) do
    Stream.transform(stream, MapSet.new(), fn event, blocked ->
      case event do
        %Events.ToolCallStart{tool_call_id: id, tool_call_name: name} ->
          if allowed_tool?(name, allow, block) do
            {[event], blocked}
          else
            {[], MapSet.put(blocked, id)}
          end

        %Events.ToolCallArgs{tool_call_id: id} ->
          if MapSet.member?(blocked, id), do: {[], blocked}, else: {[event], blocked}

        %Events.ToolCallEnd{tool_call_id: id} ->
          if MapSet.member?(blocked, id) do
            {[], MapSet.delete(blocked, id)}
          else
            {[event], blocked}
          end

        %Events.ToolCallResult{tool_call_id: id} ->
          if MapSet.member?(blocked, id), do: {[], blocked}, else: {[event], blocked}

        _ ->
          {[event], blocked}
      end
    end)
  end

  defp allowed_tool?(name, allow, _block) when is_struct(allow, MapSet) do
    MapSet.member?(allow, name)
  end

  defp allowed_tool?(name, _allow, block) when is_struct(block, MapSet) do
    not MapSet.member?(block, name)
  end

  defp allowed_tool?(_name, _allow, _block), do: true
end
