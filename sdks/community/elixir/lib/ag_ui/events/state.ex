defmodule AgUI.Events.StateSnapshot do
  @moduledoc """
  Event containing a complete snapshot of the agent state.

  ## Wire Format

      {
        "type": "STATE_SNAPSHOT",
        "snapshot": {"counter": 5, "items": []},
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :state_snapshot,
          snapshot: term(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :snapshot,
    :timestamp,
    :raw_event,
    type: :state_snapshot
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "STATE_SNAPSHOT", "snapshot" => snapshot} = map) do
    {:ok,
     %__MODULE__{
       type: :state_snapshot,
       snapshot: snapshot,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "STATE_SNAPSHOT"}), do: {:error, :missing_snapshot}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "STATE_SNAPSHOT",
      "snapshot" => event.snapshot,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.StateDelta do
  @moduledoc """
  Event containing a JSON Patch (RFC 6902) delta to apply to state.

  ## Wire Format

      {
        "type": "STATE_DELTA",
        "delta": [{"op": "replace", "path": "/counter", "value": 6}],
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :state_delta,
          delta: [map()],
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :delta,
    :timestamp,
    :raw_event,
    type: :state_delta
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "STATE_DELTA", "delta" => delta} = map) when is_list(delta) do
    {:ok,
     %__MODULE__{
       type: :state_delta,
       delta: delta,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "STATE_DELTA"}), do: {:error, :missing_delta}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "STATE_DELTA",
      "delta" => event.delta,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.MessagesSnapshot do
  @moduledoc """
  Event containing a complete snapshot of the conversation messages.

  ## Wire Format

      {
        "type": "MESSAGES_SNAPSHOT",
        "messages": [{"id": "1", "role": "user", "content": "Hello"}],
        "timestamp": 1234567890
      }

  """

  alias AgUI.Types.Message

  @type t :: %__MODULE__{
          type: :messages_snapshot,
          messages: [Message.t()],
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :messages,
    :timestamp,
    :raw_event,
    type: :messages_snapshot
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "MESSAGES_SNAPSHOT", "messages" => messages} = map)
      when is_list(messages) do
    with {:ok, decoded} <- parse_messages(messages) do
      {:ok,
       %__MODULE__{
         type: :messages_snapshot,
         messages: decoded,
         timestamp: map["timestamp"],
         raw_event: map
       }}
    end
  end

  def from_map(%{"type" => "MESSAGES_SNAPSHOT"}), do: {:error, :missing_messages}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "MESSAGES_SNAPSHOT",
      "messages" => Enum.map(event.messages, &encode_message/1),
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end

  defp parse_messages(messages) do
    results = Enum.map(messages, &Message.from_map/1)

    case Enum.find(results, &match?({:error, _}, &1)) do
      nil -> {:ok, Enum.map(results, fn {:ok, m} -> m end)}
      error -> error
    end
  end

  defp encode_message(msg) do
    try do
      Message.to_map(msg)
    rescue
      FunctionClauseError -> msg
    end
  end
end

defmodule AgUI.Events.ActivitySnapshot do
  @moduledoc """
  Event containing an activity message for structured UI rendering.

  Activities are used for structured UI elements like progress indicators,
  search results, plans, etc.

  ## Wire Format

      {
        "type": "ACTIVITY_SNAPSHOT",
        "messageId": "msg-123",
        "activityType": "search_results",
        "content": {"results": [...]},
        "replace": true,
        "timestamp": 1234567890
      }

  The `replace` field defaults to true. When true, an existing message
  with the same ID will be replaced; when false, a new message is appended.
  """

  @type t :: %__MODULE__{
          type: :activity_snapshot,
          message_id: String.t(),
          activity_type: String.t(),
          content: term(),
          replace: boolean(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :activity_type,
    :content,
    :timestamp,
    :raw_event,
    type: :activity_snapshot,
    replace: true
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(
        %{
          "type" => "ACTIVITY_SNAPSHOT",
          "messageId" => message_id,
          "activityType" => activity_type,
          "content" => content
        } = map
      )
      when is_binary(message_id) and is_binary(activity_type) do
    {:ok,
     %__MODULE__{
       type: :activity_snapshot,
       message_id: message_id,
       activity_type: activity_type,
       content: content,
       replace: Map.get(map, "replace", true),
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "ACTIVITY_SNAPSHOT"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "ACTIVITY_SNAPSHOT",
      "messageId" => event.message_id,
      "activityType" => event.activity_type,
      "content" => event.content,
      "replace" => event.replace,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ActivityDelta do
  @moduledoc """
  Event containing a JSON Patch to apply to an activity message's content.

  ## Wire Format

      {
        "type": "ACTIVITY_DELTA",
        "messageId": "msg-123",
        "activityType": "search_results",
        "patch": [{"op": "add", "path": "/results/-", "value": {...}}],
        "timestamp": 1234567890
      }

  Note: The field is named `patch` (not `delta`) to distinguish from state deltas.
  """

  @type t :: %__MODULE__{
          type: :activity_delta,
          message_id: String.t(),
          activity_type: String.t(),
          patch: [map()],
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :activity_type,
    :patch,
    :timestamp,
    :raw_event,
    type: :activity_delta
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(
        %{
          "type" => "ACTIVITY_DELTA",
          "messageId" => message_id,
          "activityType" => activity_type,
          "patch" => patch
        } = map
      )
      when is_binary(message_id) and is_binary(activity_type) and is_list(patch) do
    {:ok,
     %__MODULE__{
       type: :activity_delta,
       message_id: message_id,
       activity_type: activity_type,
       patch: patch,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "ACTIVITY_DELTA"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "ACTIVITY_DELTA",
      "messageId" => event.message_id,
      "activityType" => event.activity_type,
      "patch" => event.patch,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end
