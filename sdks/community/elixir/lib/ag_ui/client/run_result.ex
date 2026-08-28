defmodule AgUI.Client.RunResult do
  @moduledoc """
  Result returned by high-level run helpers.
  """

  alias AgUI.Session
  alias AgUI.Types.Message

  @type t :: %__MODULE__{
          result: term(),
          new_messages: [Message.t()],
          session: Session.t()
        }

  defstruct result: nil, new_messages: [], session: %Session{}
end
