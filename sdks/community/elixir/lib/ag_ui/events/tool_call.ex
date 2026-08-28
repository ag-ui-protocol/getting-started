defmodule AgUI.Events.ToolCallStart do
  @moduledoc """
  Event indicating the start of a tool call.

  ## Wire Format

      {
        "type": "TOOL_CALL_START",
        "toolCallId": "call-123",
        "toolCallName": "get_weather",
        "parentMessageId": "msg-456",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :tool_call_start,
          tool_call_id: String.t(),
          tool_call_name: String.t(),
          parent_message_id: String.t() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :tool_call_id,
    :tool_call_name,
    :parent_message_id,
    :timestamp,
    :raw_event,
    type: :tool_call_start
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(
        %{
          "type" => "TOOL_CALL_START",
          "toolCallId" => tool_call_id,
          "toolCallName" => tool_call_name
        } = map
      )
      when is_binary(tool_call_id) and is_binary(tool_call_name) do
    {:ok,
     %__MODULE__{
       type: :tool_call_start,
       tool_call_id: tool_call_id,
       tool_call_name: tool_call_name,
       parent_message_id: map["parentMessageId"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "TOOL_CALL_START"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TOOL_CALL_START",
      "toolCallId" => event.tool_call_id,
      "toolCallName" => event.tool_call_name,
      "parentMessageId" => event.parent_message_id,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ToolCallArgs do
  @moduledoc """
  Event containing a chunk of tool call arguments.

  ## Wire Format

      {
        "type": "TOOL_CALL_ARGS",
        "toolCallId": "call-123",
        "delta": "{\"location\":",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :tool_call_args,
          tool_call_id: String.t(),
          delta: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :tool_call_id,
    :delta,
    :timestamp,
    :raw_event,
    type: :tool_call_args
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(
        %{"type" => "TOOL_CALL_ARGS", "toolCallId" => tool_call_id, "delta" => delta} = map
      )
      when is_binary(tool_call_id) and is_binary(delta) do
    {:ok,
     %__MODULE__{
       type: :tool_call_args,
       tool_call_id: tool_call_id,
       delta: delta,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "TOOL_CALL_ARGS"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TOOL_CALL_ARGS",
      "toolCallId" => event.tool_call_id,
      "delta" => event.delta,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ToolCallEnd do
  @moduledoc """
  Event indicating the end of a tool call stream.

  ## Wire Format

      {
        "type": "TOOL_CALL_END",
        "toolCallId": "call-123",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :tool_call_end,
          tool_call_id: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :tool_call_id,
    :timestamp,
    :raw_event,
    type: :tool_call_end
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "TOOL_CALL_END", "toolCallId" => tool_call_id} = map)
      when is_binary(tool_call_id) do
    {:ok,
     %__MODULE__{
       type: :tool_call_end,
       tool_call_id: tool_call_id,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "TOOL_CALL_END"}), do: {:error, :missing_tool_call_id}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TOOL_CALL_END",
      "toolCallId" => event.tool_call_id,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ToolCallResult do
  @moduledoc """
  Event containing the result of a tool execution.

  ## Wire Format

      {
        "type": "TOOL_CALL_RESULT",
        "messageId": "msg-789",
        "toolCallId": "call-123",
        "content": "{\"temperature\": 72}",
        "role": "tool",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :tool_call_result,
          message_id: String.t(),
          tool_call_id: String.t(),
          content: String.t(),
          role: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message_id,
    :tool_call_id,
    :content,
    :timestamp,
    :raw_event,
    type: :tool_call_result,
    role: "tool"
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(
        %{
          "type" => "TOOL_CALL_RESULT",
          "messageId" => message_id,
          "toolCallId" => tool_call_id,
          "content" => content
        } = map
      )
      when is_binary(message_id) and is_binary(tool_call_id) and is_binary(content) do
    {:ok,
     %__MODULE__{
       type: :tool_call_result,
       message_id: message_id,
       tool_call_id: tool_call_id,
       content: content,
       role: map["role"] || "tool",
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "TOOL_CALL_RESULT"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TOOL_CALL_RESULT",
      "messageId" => event.message_id,
      "toolCallId" => event.tool_call_id,
      "content" => event.content,
      "role" => event.role,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ToolCallChunk do
  @moduledoc """
  Convenience event combining start/args into a single chunk.

  This is a compact format that gets expanded into canonical
  START/ARGS/END events during normalization.

  ## Wire Format

      {
        "type": "TOOL_CALL_CHUNK",
        "toolCallId": "call-123",
        "toolCallName": "get_weather",
        "parentMessageId": "msg-456",
        "delta": "{\"loc",
        "timestamp": 1234567890
      }

  All fields except type are optional. The first chunk must include toolCallId and toolCallName.
  """

  @type t :: %__MODULE__{
          type: :tool_call_chunk,
          tool_call_id: String.t() | nil,
          tool_call_name: String.t() | nil,
          parent_message_id: String.t() | nil,
          delta: String.t() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :tool_call_id,
    :tool_call_name,
    :parent_message_id,
    :delta,
    :timestamp,
    :raw_event,
    type: :tool_call_chunk
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "TOOL_CALL_CHUNK"} = map) do
    {:ok,
     %__MODULE__{
       type: :tool_call_chunk,
       tool_call_id: map["toolCallId"],
       tool_call_name: map["toolCallName"],
       parent_message_id: map["parentMessageId"],
       delta: map["delta"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "TOOL_CALL_CHUNK",
      "toolCallId" => event.tool_call_id,
      "toolCallName" => event.tool_call_name,
      "parentMessageId" => event.parent_message_id,
      "delta" => event.delta,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end
