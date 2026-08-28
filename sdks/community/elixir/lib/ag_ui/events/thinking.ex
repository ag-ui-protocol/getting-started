defmodule AgUI.Events.ThinkingStart do
  @moduledoc """
  Event indicating the agent has started thinking.

  Thinking events allow agents to communicate internal reasoning
  to the UI without including it in the main conversation.

  ## Wire Format

      {
        "type": "THINKING_START",
        "title": "Analyzing the problem...",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :thinking_start,
          title: String.t() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :title,
    :timestamp,
    :raw_event,
    type: :thinking_start
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "THINKING_START"} = map) do
    {:ok,
     %__MODULE__{
       type: :thinking_start,
       title: map["title"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "THINKING_START",
      "title" => event.title,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ThinkingEnd do
  @moduledoc """
  Event indicating the agent has finished thinking.

  ## Wire Format

      {
        "type": "THINKING_END",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :thinking_end,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :timestamp,
    :raw_event,
    type: :thinking_end
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "THINKING_END"} = map) do
    {:ok,
     %__MODULE__{
       type: :thinking_end,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "THINKING_END",
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ThinkingTextMessageStart do
  @moduledoc """
  Event indicating the start of a thinking text message.

  This is similar to TEXT_MESSAGE_START but for internal reasoning
  that won't be added to the main conversation.

  ## Wire Format

      {
        "type": "THINKING_TEXT_MESSAGE_START",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :thinking_text_message_start,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :timestamp,
    :raw_event,
    type: :thinking_text_message_start
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "THINKING_TEXT_MESSAGE_START"} = map) do
    {:ok,
     %__MODULE__{
       type: :thinking_text_message_start,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "THINKING_TEXT_MESSAGE_START",
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ThinkingTextMessageContent do
  @moduledoc """
  Event containing a chunk of thinking text content.

  ## Wire Format

      {
        "type": "THINKING_TEXT_MESSAGE_CONTENT",
        "delta": "Let me analyze...",
        "timestamp": 1234567890
      }

  Note: Unlike TEXT_MESSAGE_CONTENT, this event does not have a messageId
  since thinking content is not added to the conversation.
  """

  @type t :: %__MODULE__{
          type: :thinking_text_message_content,
          delta: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :delta,
    :timestamp,
    :raw_event,
    type: :thinking_text_message_content
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "THINKING_TEXT_MESSAGE_CONTENT", "delta" => delta} = map)
      when is_binary(delta) and byte_size(delta) > 0 do
    {:ok,
     %__MODULE__{
       type: :thinking_text_message_content,
       delta: delta,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "THINKING_TEXT_MESSAGE_CONTENT", "delta" => ""}),
    do: {:error, :empty_delta}

  def from_map(%{"type" => "THINKING_TEXT_MESSAGE_CONTENT"}), do: {:error, :missing_delta}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "THINKING_TEXT_MESSAGE_CONTENT",
      "delta" => event.delta,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.ThinkingTextMessageEnd do
  @moduledoc """
  Event indicating the end of a thinking text message.

  ## Wire Format

      {
        "type": "THINKING_TEXT_MESSAGE_END",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :thinking_text_message_end,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :timestamp,
    :raw_event,
    type: :thinking_text_message_end
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "THINKING_TEXT_MESSAGE_END"} = map) do
    {:ok,
     %__MODULE__{
       type: :thinking_text_message_end,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "THINKING_TEXT_MESSAGE_END",
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end
