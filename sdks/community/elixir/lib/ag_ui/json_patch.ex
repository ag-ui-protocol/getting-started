defmodule AgUI.JSONPatch do
  @moduledoc """
  RFC 6902 JSON Patch wrapper.

  > Note: This module defines its own `apply/2` function, which shadows
  > `Kernel.apply/2`. Use `Kernel.apply/2` explicitly if needed.

  Import with: `import AgUI.JSONPatch` or use fully-qualified calls.

  Provides a thin wrapper around the `jsonpatch` library for applying
  JSON Patch operations to documents. Used for STATE_DELTA and ACTIVITY_DELTA
  event processing.

  ## Operations

  Supports all RFC 6902 operations:
  - `add` - Add a value at a path
  - `remove` - Remove a value at a path
  - `replace` - Replace a value at a path
  - `move` - Move a value from one path to another
  - `copy` - Copy a value from one path to another
  - `test` - Test that a value at a path equals expected value

  ## Example

      iex> doc = %{"counter" => 1, "items" => []}
      iex> ops = [%{"op" => "replace", "path" => "/counter", "value" => 2}]
      iex> AgUI.JSONPatch.apply(doc, ops)
      {:ok, %{"counter" => 2, "items" => []}}

  """

  import Kernel, except: [apply: 2]

  @type operation :: %{
          required(String.t()) => String.t() | any()
        }

  @doc """
  Applies a list of JSON Patch operations to a document.

  Returns `{:ok, patched_document}` on success, `{:error, reason}` on failure.
  If the operations list is empty, returns the document unchanged.

  ## Parameters

  - `document` - The document to patch (map)
  - `operations` - List of RFC 6902 patch operations

  ## Examples

      iex> AgUI.JSONPatch.apply(%{"a" => 1}, [%{"op" => "add", "path" => "/b", "value" => 2}])
      {:ok, %{"a" => 1, "b" => 2}}

      iex> AgUI.JSONPatch.apply(%{"a" => 1}, [%{"op" => "remove", "path" => "/missing"}])
      {:error, {:patch_failed, _}}

  """
  @spec apply(term(), [operation()]) :: {:ok, term()} | {:error, term()}
  def apply(document, []) do
    {:ok, document}
  end

  def apply(document, operations) when is_list(operations) do
    # Convert operations to Jsonpatch structs
    patches = Enum.map(operations, &operation_to_patch/1)

    case Jsonpatch.apply_patch(patches, document) do
      {:ok, result} ->
        {:ok, result}

      {:error, %Jsonpatch.Error{} = error} ->
        {:error, {:patch_failed, error}}
    end
  rescue
    e -> {:error, {:patch_exception, e}}
  end

  def apply(_document, operations) when not is_list(operations) do
    {:error, :invalid_operations}
  end

  @doc """
  Applies a list of JSON Patch operations to a document, raising on failure.

  ## Examples

      iex> AgUI.JSONPatch.apply!(%{"a" => 1}, [%{"op" => "add", "path" => "/b", "value" => 2}])
      %{"a" => 1, "b" => 2}

  """
  @spec apply!(term(), [operation()]) :: term()
  def apply!(document, operations) do
    case __MODULE__.apply(document, operations) do
      {:ok, result} -> result
      {:error, reason} -> raise ArgumentError, "JSON Patch failed: #{inspect(reason)}"
    end
  end

  # Convert wire format operation map to Jsonpatch struct
  defp operation_to_patch(%{"op" => "add", "path" => path, "value" => value}) do
    %Jsonpatch.Operation.Add{path: path, value: value}
  end

  defp operation_to_patch(%{"op" => "remove", "path" => path}) do
    %Jsonpatch.Operation.Remove{path: path}
  end

  defp operation_to_patch(%{"op" => "replace", "path" => path, "value" => value}) do
    %Jsonpatch.Operation.Replace{path: path, value: value}
  end

  defp operation_to_patch(%{"op" => "move", "path" => path, "from" => from}) do
    %Jsonpatch.Operation.Move{path: path, from: from}
  end

  defp operation_to_patch(%{"op" => "copy", "path" => path, "from" => from}) do
    %Jsonpatch.Operation.Copy{path: path, from: from}
  end

  defp operation_to_patch(%{"op" => "test", "path" => path, "value" => value}) do
    %Jsonpatch.Operation.Test{path: path, value: value}
  end

  # Handle unknown operations gracefully
  defp operation_to_patch(op) do
    raise ArgumentError, "Unknown JSON Patch operation: #{inspect(op)}"
  end
end
