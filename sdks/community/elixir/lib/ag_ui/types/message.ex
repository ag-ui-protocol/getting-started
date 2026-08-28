# Message variant modules must be defined first so structs are available

defmodule AgUI.Types.Message.Developer do
  @moduledoc """
  Developer message containing system-level instructions.
  """

  @type t :: %__MODULE__{
          id: String.t(),
          role: :developer,
          content: String.t(),
          name: String.t() | nil
        }

  @enforce_keys [:id, :content]
  defstruct [:id, :content, :name, role: :developer]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id, "content" => content} = map)
      when is_binary(id) and is_binary(content) do
    {:ok,
     %__MODULE__{
       id: id,
       role: :developer,
       content: content,
       name: map["name"]
     }}
  end

  def from_map(%{"id" => _, "content" => _}), do: {:error, :invalid_types}
  def from_map(_), do: {:error, :missing_required_fields}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = msg) do
    %{
      "id" => msg.id,
      "role" => "developer",
      "content" => msg.content,
      "name" => msg.name
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Types.Message.System do
  @moduledoc """
  System message containing instructions for the agent.
  """

  @type t :: %__MODULE__{
          id: String.t(),
          role: :system,
          content: String.t(),
          name: String.t() | nil
        }

  @enforce_keys [:id, :content]
  defstruct [:id, :content, :name, role: :system]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id, "content" => content} = map)
      when is_binary(id) and is_binary(content) do
    {:ok,
     %__MODULE__{
       id: id,
       role: :system,
       content: content,
       name: map["name"]
     }}
  end

  def from_map(%{"id" => _, "content" => _}), do: {:error, :invalid_types}
  def from_map(_), do: {:error, :missing_required_fields}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = msg) do
    %{
      "id" => msg.id,
      "role" => "system",
      "content" => msg.content,
      "name" => msg.name
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Types.Message.User do
  @moduledoc """
  User message containing input from the user.

  Content can be either a plain string or a list of InputContent
  for multimodal messages.
  """

  alias AgUI.Types.InputContent

  @type content :: String.t() | [InputContent.t()]

  @type t :: %__MODULE__{
          id: String.t(),
          role: :user,
          content: content(),
          name: String.t() | nil
        }

  @enforce_keys [:id, :content]
  defstruct [:id, :content, :name, role: :user]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id, "content" => content} = map) when is_binary(id) do
    case parse_content(content) do
      {:ok, parsed_content} ->
        {:ok,
         %__MODULE__{
           id: id,
           role: :user,
           content: parsed_content,
           name: map["name"]
         }}

      error ->
        error
    end
  end

  def from_map(%{"id" => _, "content" => _}), do: {:error, :invalid_id_type}
  def from_map(_), do: {:error, :missing_required_fields}

  defp parse_content(content) when is_binary(content), do: {:ok, content}

  defp parse_content(content) when is_list(content) do
    results = Enum.map(content, &InputContent.from_map/1)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil ->
        {:ok, Enum.map(results, fn {:ok, c} -> c end)}

      error ->
        error
    end
  end

  defp parse_content(_), do: {:error, :invalid_content_type}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = msg) do
    content =
      case msg.content do
        c when is_binary(c) -> c
        c when is_list(c) -> Enum.map(c, &InputContent.to_map/1)
      end

    %{
      "id" => msg.id,
      "role" => "user",
      "content" => content,
      "name" => msg.name
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Types.Message.Assistant do
  @moduledoc """
  Assistant message containing the agent's response.

  Can include text content and/or tool calls.
  """

  alias AgUI.Types.ToolCall

  @type t :: %__MODULE__{
          id: String.t(),
          role: :assistant,
          content: String.t() | nil,
          name: String.t() | nil,
          tool_calls: [ToolCall.t()]
        }

  @enforce_keys [:id]
  defstruct [:id, :content, :name, role: :assistant, tool_calls: []]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id} = map) when is_binary(id) do
    tool_calls =
      case map["toolCalls"] do
        nil ->
          []

        calls when is_list(calls) ->
          Enum.map(calls, fn call ->
            case ToolCall.from_map(call) do
              {:ok, tc} -> tc
              {:error, _} -> nil
            end
          end)
          |> Enum.reject(&is_nil/1)

        _ ->
          []
      end

    {:ok,
     %__MODULE__{
       id: id,
       role: :assistant,
       content: map["content"],
       name: map["name"],
       tool_calls: tool_calls
     }}
  end

  def from_map(%{"id" => _}), do: {:error, :invalid_id_type}
  def from_map(_), do: {:error, :missing_id}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = msg) do
    base = %{
      "id" => msg.id,
      "role" => "assistant",
      "content" => msg.content,
      "name" => msg.name
    }

    base =
      if msg.tool_calls != [] do
        Map.put(base, "toolCalls", Enum.map(msg.tool_calls, &ToolCall.to_map/1))
      else
        base
      end

    AgUI.Types.compact_map(base)
  end
end

defmodule AgUI.Types.Message.Tool do
  @moduledoc """
  Tool message containing the result of a tool execution.
  """

  @type t :: %__MODULE__{
          id: String.t(),
          role: :tool,
          content: String.t(),
          tool_call_id: String.t(),
          error: String.t() | nil
        }

  @enforce_keys [:id, :content, :tool_call_id]
  defstruct [:id, :content, :tool_call_id, :error, role: :tool]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id, "content" => content, "toolCallId" => tool_call_id} = map)
      when is_binary(id) and is_binary(content) and is_binary(tool_call_id) do
    {:ok,
     %__MODULE__{
       id: id,
       role: :tool,
       content: content,
       tool_call_id: tool_call_id,
       error: map["error"]
     }}
  end

  def from_map(%{"id" => _, "content" => _, "toolCallId" => _}), do: {:error, :invalid_types}
  def from_map(_), do: {:error, :missing_required_fields}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = msg) do
    %{
      "id" => msg.id,
      "role" => "tool",
      "content" => msg.content,
      "toolCallId" => msg.tool_call_id,
      "error" => msg.error
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Types.Message.Activity do
  @moduledoc """
  Activity message containing structured data for frontend rendering.

  Activities are used for structured UI elements like progress indicators,
  search results, plans, etc.
  """

  @type t :: %__MODULE__{
          id: String.t(),
          role: :activity,
          activity_type: String.t(),
          content: term()
        }

  @enforce_keys [:id, :activity_type, :content]
  defstruct [:id, :activity_type, :content, role: :activity]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"id" => id, "activityType" => activity_type, "content" => content} = _map)
      when is_binary(id) and is_binary(activity_type) do
    {:ok,
     %__MODULE__{
       id: id,
       role: :activity,
       activity_type: activity_type,
       content: content
     }}
  end

  def from_map(%{"id" => _, "activityType" => _, "content" => _}), do: {:error, :invalid_types}
  def from_map(_), do: {:error, :missing_required_fields}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = msg) do
    %{
      "id" => msg.id,
      "role" => "activity",
      "activityType" => msg.activity_type,
      "content" => msg.content
    }
  end
end

# Main Message module - defined last so all variant structs are available

defmodule AgUI.Types.Message do
  @moduledoc """
  Union type for all message variants in the AG-UI protocol.

  Messages represent the conversation history between users and agents.
  Each message has a role that determines its type and available fields.

  ## Roles

  - `:developer` - System-level instructions (similar to system, but from developer)
  - `:system` - System-level instructions
  - `:user` - User input (can be text or multimodal)
  - `:assistant` - Agent responses (can include tool calls)
  - `:tool` - Results from tool executions
  - `:activity` - Structured activity data for frontend rendering

  ## Wire Format

  Messages are discriminated by the "role" field:

      {"id": "msg_1", "role": "user", "content": "Hello"}
      {"id": "msg_2", "role": "assistant", "content": "Hi there!", "toolCalls": [...]}
      {"id": "msg_3", "role": "tool", "content": "...", "toolCallId": "call_123"}

  """

  alias __MODULE__.{Developer, System, User, Assistant, Tool, Activity}

  @type role :: :developer | :system | :user | :assistant | :tool | :activity

  @type t :: Developer.t() | System.t() | User.t() | Assistant.t() | Tool.t() | Activity.t()

  @role_mapping %{
    "developer" => :developer,
    "system" => :system,
    "user" => :user,
    "assistant" => :assistant,
    "tool" => :tool,
    "activity" => :activity
  }

  @reverse_role_mapping Map.new(@role_mapping, fn {k, v} -> {v, k} end)

  @doc """
  Converts a wire format role string to an atom.
  """
  @spec role_from_wire(String.t()) :: {:ok, role()} | {:error, term()}
  def role_from_wire(role) when is_binary(role) do
    case Map.fetch(@role_mapping, role) do
      {:ok, atom} -> {:ok, atom}
      :error -> {:error, {:unknown_role, role}}
    end
  end

  @doc """
  Converts a role atom to wire format string.
  """
  @spec role_to_wire(role()) :: String.t()
  def role_to_wire(role) when is_atom(role) do
    Map.fetch!(@reverse_role_mapping, role)
  end

  @doc """
  Creates a Message from a wire format map.

  Dispatches to the appropriate message type based on the "role" field.

  ## Examples

      iex> AgUI.Types.Message.from_map(%{"id" => "1", "role" => "user", "content" => "Hi"})
      {:ok, %AgUI.Types.Message.User{id: "1", role: :user, content: "Hi"}}

  """
  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"role" => "developer"} = map), do: Developer.from_map(map)
  def from_map(%{"role" => "system"} = map), do: System.from_map(map)
  def from_map(%{"role" => "user"} = map), do: User.from_map(map)
  def from_map(%{"role" => "assistant"} = map), do: Assistant.from_map(map)
  def from_map(%{"role" => "tool"} = map), do: Tool.from_map(map)
  def from_map(%{"role" => "activity"} = map), do: Activity.from_map(map)

  def from_map(%{"role" => role}) when is_binary(role) do
    {:error, {:unknown_role, role}}
  end

  def from_map(_) do
    {:error, :missing_role}
  end

  @doc """
  Converts a Message to wire format map.
  """
  @spec to_map(t()) :: map()
  def to_map(%Developer{} = msg), do: Developer.to_map(msg)
  def to_map(%System{} = msg), do: System.to_map(msg)
  def to_map(%User{} = msg), do: User.to_map(msg)
  def to_map(%Assistant{} = msg), do: Assistant.to_map(msg)
  def to_map(%Tool{} = msg), do: Tool.to_map(msg)
  def to_map(%Activity{} = msg), do: Activity.to_map(msg)

  @doc """
  Returns the role of a message.
  """
  @spec role(t()) :: role()
  def role(%{role: role}), do: role

  @doc """
  Returns the ID of a message.
  """
  @spec id(t()) :: String.t()
  def id(%{id: id}), do: id
end
