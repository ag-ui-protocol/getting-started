defmodule AgUI.Encoder do
  @moduledoc """
  Event encoder utilities.

  Encodes AG-UI events into wire formats suitable for transport layers.
  """

  alias AgUI.Events

  @type content_type :: String.t()

  @doc """
  Encodes an AG-UI event for transport.

  Currently supports JSON encoding only.

  ## Examples

      event = %AgUI.Events.RunStarted{thread_id: "t1", run_id: "r1"}
      AgUI.Encoder.encode_event(event)
  """
  @spec encode_event(Events.t(), content_type()) :: binary()
  def encode_event(event, content_type \\ "application/json")

  def encode_event(event, "application/json") do
    event
    |> Events.encode()
    |> Jason.encode!()
  end

  def encode_event(_event, content_type) when is_binary(content_type) do
    raise ArgumentError, "unsupported content type: #{content_type}"
  end
end
