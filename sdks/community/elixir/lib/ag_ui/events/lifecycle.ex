defmodule AgUI.Events.RunStarted do
  @moduledoc """
  Event indicating a run has started.

  ## Wire Format

      {
        "type": "RUN_STARTED",
        "threadId": "thread-123",
        "runId": "run-456",
        "parentRunId": "run-455",
        "timestamp": 1234567890
      }

  """

  @type t :: %__MODULE__{
          type: :run_started,
          thread_id: String.t(),
          run_id: String.t(),
          parent_run_id: String.t() | nil,
          input: map() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :thread_id,
    :run_id,
    :parent_run_id,
    :input,
    :timestamp,
    :raw_event,
    type: :run_started
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "RUN_STARTED", "threadId" => thread_id, "runId" => run_id} = map)
      when is_binary(thread_id) and is_binary(run_id) do
    {:ok,
     %__MODULE__{
       type: :run_started,
       thread_id: thread_id,
       run_id: run_id,
       parent_run_id: map["parentRunId"],
       input: map["input"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "RUN_STARTED"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "RUN_STARTED",
      "threadId" => event.thread_id,
      "runId" => event.run_id,
      "parentRunId" => event.parent_run_id,
      "input" => event.input,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.RunFinished do
  @moduledoc """
  Event indicating a run has completed successfully.
  """

  @type t :: %__MODULE__{
          type: :run_finished,
          thread_id: String.t(),
          run_id: String.t(),
          result: term() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :thread_id,
    :run_id,
    :result,
    :timestamp,
    :raw_event,
    type: :run_finished
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "RUN_FINISHED", "threadId" => thread_id, "runId" => run_id} = map)
      when is_binary(thread_id) and is_binary(run_id) do
    {:ok,
     %__MODULE__{
       type: :run_finished,
       thread_id: thread_id,
       run_id: run_id,
       result: map["result"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "RUN_FINISHED"}), do: {:error, :missing_required_fields}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "RUN_FINISHED",
      "threadId" => event.thread_id,
      "runId" => event.run_id,
      "result" => event.result,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.RunError do
  @moduledoc """
  Event indicating a run encountered an error.
  """

  @type t :: %__MODULE__{
          type: :run_error,
          message: String.t(),
          code: String.t() | nil,
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :message,
    :code,
    :timestamp,
    :raw_event,
    type: :run_error
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "RUN_ERROR", "message" => message} = map) when is_binary(message) do
    {:ok,
     %__MODULE__{
       type: :run_error,
       message: message,
       code: map["code"],
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "RUN_ERROR"}), do: {:error, :missing_message}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "RUN_ERROR",
      "message" => event.message,
      "code" => event.code,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.StepStarted do
  @moduledoc """
  Event indicating a step has started within a run.
  """

  @type t :: %__MODULE__{
          type: :step_started,
          step_name: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :step_name,
    :timestamp,
    :raw_event,
    type: :step_started
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "STEP_STARTED", "stepName" => step_name} = map)
      when is_binary(step_name) do
    {:ok,
     %__MODULE__{
       type: :step_started,
       step_name: step_name,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "STEP_STARTED"}), do: {:error, :missing_step_name}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "STEP_STARTED",
      "stepName" => event.step_name,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end

defmodule AgUI.Events.StepFinished do
  @moduledoc """
  Event indicating a step has completed within a run.
  """

  @type t :: %__MODULE__{
          type: :step_finished,
          step_name: String.t(),
          timestamp: integer() | nil,
          raw_event: map() | nil
        }

  defstruct [
    :step_name,
    :timestamp,
    :raw_event,
    type: :step_finished
  ]

  @spec from_map(map()) :: {:ok, t()} | {:error, term()}
  def from_map(%{"type" => "STEP_FINISHED", "stepName" => step_name} = map)
      when is_binary(step_name) do
    {:ok,
     %__MODULE__{
       type: :step_finished,
       step_name: step_name,
       timestamp: map["timestamp"],
       raw_event: map
     }}
  end

  def from_map(%{"type" => "STEP_FINISHED"}), do: {:error, :missing_step_name}
  def from_map(_), do: {:error, :invalid_event}

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = event) do
    %{
      "type" => "STEP_FINISHED",
      "stepName" => event.step_name,
      "timestamp" => event.timestamp
    }
    |> AgUI.Types.compact_map()
  end
end
