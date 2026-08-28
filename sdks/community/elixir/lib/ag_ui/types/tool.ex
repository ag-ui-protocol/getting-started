defmodule AgUI.Types.Tool do
  @moduledoc """
  Definition of a tool that can be called by an agent.

  Tools are defined with a name, description, and JSON Schema
  for their parameters. They represent capabilities that the
  frontend provides to the agent.

  ## Wire Format

      {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name"
            }
          },
          "required": ["location"]
        }
      }

  """

  @type t :: %__MODULE__{
          name: String.t(),
          description: String.t(),
          parameters: map()
        }

  @enforce_keys [:name, :description]
  defstruct [:name, :description, parameters: %{}]

  @doc """
  Creates a Tool from a wire format map.

  ## Examples

      iex> AgUI.Types.Tool.from_map(%{
      ...>   "name" => "search",
      ...>   "description" => "Search the web",
      ...>   "parameters" => %{"type" => "object"}
      ...> })
      {:ok, %AgUI.Types.Tool{name: "search", description: "Search the web", parameters: %{"type" => "object"}}}

  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"name" => name, "description" => description} = map)
      when is_binary(name) and is_binary(description) do
    {:ok,
     %__MODULE__{
       name: name,
       description: description,
       parameters: map["parameters"] || %{}
     }}
  end

  def from_map(%{"name" => _, "description" => _}) do
    {:error, :invalid_types}
  end

  def from_map(_) do
    {:error, :missing_required_fields}
  end

  @doc """
  Converts a Tool to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = tool) do
    %{
      "name" => tool.name,
      "description" => tool.description,
      "parameters" => tool.parameters
    }
  end
end
