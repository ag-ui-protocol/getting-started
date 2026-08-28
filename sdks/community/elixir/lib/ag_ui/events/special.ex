defmodule AgUI.Events.Raw do
  @moduledoc """
  Event containing raw, passthrough data from the underlying provider.

  This event allows agents to forward provider-specific events
  that don't map to standard AG-UI events.

  ## Wire Format

      {
        "type": "RAW",
        "event": {"provider_specific": "data"},
        "source": "openai",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :raw,
          event: term(),
          source: String.t() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :event,
    :source,
    :timestamp,
    :raw_event,
    type: :raw
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "RAW", "event" => event} = map) do
    {:ok,
     %__MODULE__{
       type: :raw,
       event: event,
       source: map["source"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "RAW"}), do: {:error, :missing_event}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "RAW",
      "event" => event.event,
      "source" => event.source,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.Custom do
  @moduledoc """
  Event for application-specific custom events.

  Custom events allow agents and UIs to communicate
  application-specific data outside the standard protocol.

  ## Wire Format

      {
        "type": "CUSTOM",
        "name": "my_custom_event",
        "value": {"any": "data"},
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :custom,
          name: String.t(),
          value: term(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :name,
    :value,
    :timestamp,
    :raw_event,
    type: :custom
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "CUSTOM", "name" => name, "value" => value} = map)
      when is_binary(name) do
    {:ok,
     %__MODULE__{
       type: :custom,
       name: name,
       value: value,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "CUSTOM"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "CUSTOM",
      "name" => event.name,
      "value" => event.value,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end
