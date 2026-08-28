defmodule AgUI.Types.Context do
  @moduledoc """
  Contextual information passed to an agent.

  Context provides additional information that helps the agent
  understand the current situation or user intent.

  ## Wire Format

      {
        "description": "User's current location",
        "value": "San Francisco, CA"
      }

  """

  @type t :: %__MODULE__{
          description: String.t(),
          value: String.t()
        }

  @enforce_keys [:description, :value]
  defstruct [:description, :value]

  @doc """
  Creates a Context from a wire format map.

  ## Examples

      iex> AgUI.Types.Context.from_map(%{"description" => "Location", "value" => "NYC"})
      {:ok, %AgUI.Types.Context{description: "Location", value: "NYC"}}

  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"description" => description, "value" => value})
      when is_binary(description) and is_binary(value) do
    {:ok, %__MODULE__{description: description, value: value}}
  end

  def from_map(%{"description" => _, "value" => _}) do
    {:error, :invalid_types}
  end

  def from_map(_) do
    {:error, :missing_required_fields}
  end

  @doc """
  Converts a Context to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = context) do
    %{
      "description" => context.description,
      "value" => context.value
    }
  end
end
