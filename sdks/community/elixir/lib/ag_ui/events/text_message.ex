defmodule AgUI.Events.TextMessageStart do
  @moduledoc """
  Event indicating the start of a text message stream.

  ## Wire Format

      {
        "type": "TEXT_MESSAGE_START",
        "messageId": "msg-123",
        "role": "assistant",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :text_message_start,
          message_id: String.t(),
          role: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :timestamp,
    :raw_event,
    type: :text_message_start,
    role: "assistant"
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "TEXT_MESSAGE_START", "messageId" => message_id} = map)
      when is_binary(message_id) do
    role = map["role"] || "assistant"

    if valid_text_role?(role) do
      {:ok,
       %__MODULE__{
         type: :text_message_start,
         message_id: message_id,
         role: role,
         timestamp: map["timestamp"],
         raw_event: map
       }}
    else
      {:error, {:invalid_role, role}}
    end
  end

  def from_map(%{"type" => "TEXT_MESSAGE_START"}), do: {:error, :missing_message_id}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TEXT_MESSAGE_START",
      "messageId" => event.message_id,
      "role" => event.role,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end

  defp valid_text_role?(role) when role in ["developer", "system", "user", "assistant"], do: true
  defp valid_text_role?(_), do: false
end

defmodule AgUI.Events.TextMessageContent do
  @moduledoc """
  Event containing a chunk of text content.

  ## Wire Format

      {
        "type": "TEXT_MESSAGE_CONTENT",
        "messageId": "msg-123",
        "delta": "Hello, ",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :text_message_content,
          message_id: String.t(),
          delta: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :delta,
    :timestamp,
    :raw_event,
    type: :text_message_content
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(
        %{"type" => "TEXT_MESSAGE_CONTENT", "messageId" => message_id, "delta" => delta} = map
      )
      when is_binary(message_id) and is_binary(delta) and byte_size(delta) > 0 do
    {:ok,
     %__MODULE__{
       type: :text_message_content,
       message_id: message_id,
       delta: delta,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "TEXT_MESSAGE_CONTENT", "delta" => ""}), do: {:error, :empty_delta}
  def from_map(%{"type" => "TEXT_MESSAGE_CONTENT"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TEXT_MESSAGE_CONTENT",
      "messageId" => event.message_id,
      "delta" => event.delta,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.TextMessageEnd do
  @moduledoc """
  Event indicating the end of a text message stream.

  ## Wire Format

      {
        "type": "TEXT_MESSAGE_END",
        "messageId": "msg-123",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :text_message_end,
          message_id: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :timestamp,
    :raw_event,
    type: :text_message_end
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "TEXT_MESSAGE_END", "messageId" => message_id} = map)
      when is_binary(message_id) do
    {:ok,
     %__MODULE__{
       type: :text_message_end,
       message_id: message_id,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "TEXT_MESSAGE_END"}), do: {:error, :missing_message_id}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TEXT_MESSAGE_END",
      "messageId" => event.message_id,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.TextMessageChunk do
  @moduledoc """
  Convenience event combining start/content into a single chunk.

  This is a compact format that gets expanded into canonical
  START/CONTENT/END events during normalization.

  ## Wire Format

      {
        "type": "TEXT_MESSAGE_CHUNK",
        "messageId": "msg-123",
        "role": "assistant",
        "delta": "Hello, ",
        "timestamp": 1234567890
      }

  All fields except type are optional. The first chunk must include messageId.
  """

  @type t :: %__MODULE__{
          type: :text_message_chunk,
          message_id: String.t() | nil,
          role: String.t() | nil,
          delta: String.t() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :role,
    :delta,
    :timestamp,
    :raw_event,
    type: :text_message_chunk
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "TEXT_MESSAGE_CHUNK"} = map) do
    role = map["role"]

    if is_nil(role) or valid_text_role?(role) do
      {:ok,
       %__MODULE__{
         type: :text_message_chunk,
         message_id: map["messageId"],
         role: role,
         delta: map["delta"],
         timestamp: map["timestamp"],
         raw_event: map
       }}
    else
      {:error, {:invalid_role, role}}
    end
  end

  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TEXT_MESSAGE_CHUNK",
      "messageId" => event.message_id,
      "role" => event.role,
      "delta" => event.delta,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end

  defp valid_text_role?(role) when role in ["developer", "system", "user", "assistant"], do: true
  defp valid_text_role?(_), do: false
end
