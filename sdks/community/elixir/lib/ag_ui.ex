defmodule AgUI do
  @moduledoc """
  Elixir SDK for the AG-UI (Agent-User Interaction) Protocol.

  AG-UI is an event-based protocol that standardizes communication between
  AI agents and user interfaces. This SDK provides:

  - Protocol types (`AgUI.Types.*`)
  - Event definitions and decoding (`AgUI.Events.*`)
  - HTTP client for SSE streaming (`AgUI.Client.HttpAgent`)
  - State management (`AgUI.Session`, `AgUI.Reducer`)
  - LiveView integration (`AgUI.LiveView.*`)

  ## Quick Start

      # Create an HTTP agent client
      agent = AgUI.Client.HttpAgent.new(url: "https://agent.example.com/run")

      # Build run input
      input = %AgUI.Types.RunAgentInput{
        thread_id: "thread-123",
        run_id: "run-456",
        messages: [],
        tools: [],
        state: %{}
      }

      # Stream events
      {:ok, stream} = AgUI.Client.HttpAgent.stream(agent, input)

      Enum.each(stream, fn event ->
        IO.inspect(event)
      end)

  ## Architecture

  The SDK is organized into layers:

  1. **Types** - Protocol data structures
  2. **Events** - Event types and decoding
  3. **Transport** - SSE parsing
  4. **Client** - HTTP agent client
  5. **Session/Reducer** - State management
  6. **LiveView** - Phoenix integration (optional)

  """

  @doc """
  Returns the SDK version.
  """
  @spec version() :: String.t()
  def version do
    "0.1.0"
  end

  @doc """
  High-level helper to run an agent and return a result.

  This is a convenience wrapper around `AgUI.Client.HttpAgent.run_agent/3`.
  """
  @spec run_agent(AgUI.Client.HttpAgent.t(), AgUI.Types.RunAgentInput.t(), keyword()) ::
          {:ok, AgUI.Client.RunResult.t()} | {:error, term()}
  defdelegate run_agent(agent, input, opts \\ []), to: AgUI.Client.HttpAgent

  @doc """
  High-level helper to run an agent and return a result, raising on error.
  """
  @spec run_agent!(AgUI.Client.HttpAgent.t(), AgUI.Types.RunAgentInput.t(), keyword()) ::
          AgUI.Client.RunResult.t()
  defdelegate run_agent!(agent, input, opts \\ []), to: AgUI.Client.HttpAgent
end
