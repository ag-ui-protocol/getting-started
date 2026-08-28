defmodule AgUI.Types do
  @moduledoc """
  Common type helpers and wire format conversion utilities.

  AG-UI uses camelCase on the wire (JSON) and this module provides
  consistent conversion to/from Elixir's snake_case convention.
  """

  @doc """
  Converts a camelCase string to snake_case atom using existing atoms only.

  ## Examples

      iex> AgUI.Types.to_snake_atom("threadId")
      :thread_id

      iex> AgUI.Types.to_snake_atom("parentMessageId")
      :parent_message_id

  """
  @spec to_snake_atom(String.t()) :: atom()
  def to_snake_atom(camel_string) when is_binary(camel_string) do
    snake = Macro.underscore(camel_string)
    String.to_existing_atom(snake)
  end

  @doc """
  Converts a snake_case atom to camelCase string.

  ## Examples

      iex> AgUI.Types.to_camel_string(:thread_id)
      "threadId"

      iex> AgUI.Types.to_camel_string(:parent_message_id)
      "parentMessageId"

  """
  @spec to_camel_string(atom()) :: String.t()
  def to_camel_string(snake_atom) when is_atom(snake_atom) do
    snake_atom
    |> Atom.to_string()
    |> camelize()
  end

  @doc """
  Converts a snake_case string to camelCase.

  ## Examples

      iex> AgUI.Types.camelize("thread_id")
      "threadId"

  """
  @spec camelize(String.t()) :: String.t()
  def camelize(snake_string) when is_binary(snake_string) do
    [first | rest] = String.split(snake_string, "_")

    capitalized =
      Enum.map(rest, fn part ->
        String.capitalize(part)
      end)

    Enum.join([first | capitalized])
  end

  @doc """
  Removes nil values from a map (for JSON encoding).
  """
  @spec compact_map(map()) :: map()
  def compact_map(map) when is_map(map) do
    map
    |> Enum.reject(fn {_k, v} -> is_nil(v) end)
    |> Map.new()
  end

  @doc """
  Removes nil values and empty lists from a map.
  """
  @spec compact_map_deep(map()) :: map()
  def compact_map_deep(map) when is_map(map) do
    map
    |> Enum.reject(fn
      {_k, nil} -> true
      {_k, []} -> true
      _ -> false
    end)
    |> Map.new()
  end
end
