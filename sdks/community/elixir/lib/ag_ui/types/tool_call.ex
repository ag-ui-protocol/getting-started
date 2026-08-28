defmodule AgUI.Types.ToolCall do
  @moduledoc """
  A tool invocation made by an agent.

  Tool calls are attached to assistant messages and represent
  the agent's request to execute a specific tool with given arguments.

  ## Wire Format

      {
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"location\": \"San Francisco\"}"
        }
      }

  Note: The `arguments` field is a JSON-encoded string, not a parsed object.
  """

  @type function_info :: %{
          name: String.t(),
          arguments: String.t()
        }

  @type t :: %__MODULE__{
          id: String.t(),
          type: :function,
          function: function_info()
        }

  @enforce_keys [:id, :function]
  defstruct [:id, :function, type: :function]

  @doc """
  Creates a ToolCall from a wire format map.

  ## Examples

      iex> AgUI.Types.ToolCall.from_map(%{
      ...>   "id" => "call_123",
      ...>   "type" => "function",
      ...>   "function" => %{"name" => "search", "arguments" => "{}"}
      ...> })
      {:ok, %AgUI.Types.ToolCall{
        id: "call_123",
        type: :function,
        function: %{name: "search", arguments: "{}"}
      }}

  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id, "function" => function} = map)
      when is_binary(id) and is_map(function) do
    type = map["type"] || "function"

    if type != "function" do
      {:error, {:invalid_type, type}}
    else
      case parse_function(function) do
        {:ok, func} ->
          {:ok, %__MODULE__{id: id, type: :function, function: func}}

        error ->
          error
      end
    end
  end

  def from_map(%{"id" => _, "function" => _}) do
    {:error, :invalid_types}
  end

  def from_map(_) do
    {:error, :missing_required_fields}
  end

  defp parse_function(%{"name" => name, "arguments" => arguments})
       when is_binary(name) and is_binary(arguments) do
    {:ok, %{name: name, arguments: arguments}}
  end

  defp parse_function(%{"name" => name}) when is_binary(name) do
    {:ok, %{name: name, arguments: ""}}
  end

  defp parse_function(_) do
    {:error, :invalid_function}
  end

  @doc """
  Converts a ToolCall to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = tool_call) do
    %{
      "id" => tool_call.id,
      "type" => "function",
      "function" => %{
        "name" => tool_call.function.name,
        "arguments" => tool_call.function.arguments
      }
    }
  end

  @doc """
  Attempts to parse the arguments as JSON.

  Returns `{:ok, parsed}` if successful, `{:error, reason}` otherwise.
  """
  @spec parse_arguments(t()) :: {:ok, term()} | {:error, term()}
  def parse_arguments(%__MODULE__{function: %{arguments: args}}) do
    Jason.decode(args)
  end
end
