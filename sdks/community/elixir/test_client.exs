#!/usr/bin/env elixir
# AG-UI Protocol Test Client
#
# A client that connects to an AG-UI agent endpoint and validates protocol events.
# Similar to the Go SDK's test client.
#
# Usage:
#   elixir test_client.exs [url]
#
# Default URL is http://localhost:4001/agent

Mix.install([
  {:ag_ui, path: "."}
])

defmodule AgUITestClient do
  @moduledoc """
  Test client for AG-UI protocol.

  Connects to an agent endpoint, streams events, and validates the protocol.
  """

  alias AgUI.Client.HttpAgent
  alias AgUI.Types.RunAgentInput
  alias AgUI.Types.Message
  alias AgUI.Verify
  alias AgUI.Events.TextMessageContent

  @doc """
  Runs the test client against the specified URL.
  """
  def run(url) do
    IO.puts("\n=== AG-UI Protocol Test Client ===\n")
    IO.puts("Connecting to: #{url}\n")

    agent = HttpAgent.new(url: url, timeout: 30_000)

    # Create test input
    input =
      RunAgentInput.new("test-thread", "test-run",
        messages: [
          %Message.User{
            id: "user-msg-1",
            role: :user,
            content: "What time is it?"
          }
        ],
        state: %{"initial" => true}
      )

    IO.puts("Sending request with:")
    IO.puts("  Thread ID: #{input.thread_id}")
    IO.puts("  Run ID: #{input.run_id}")
    IO.puts("  Messages: #{length(input.messages)}")
    IO.puts("")

    # Test 1: Basic stream
    IO.puts("--- Test 1: Raw Event Streaming ---\n")
    test_raw_stream(agent, input)

    # Test 2: Decoded event streaming
    IO.puts("\n--- Test 2: Decoded Event Streaming ---\n")
    test_decoded_stream(agent, input)

    # Test 3: Canonical stream with normalization
    IO.puts("\n--- Test 3: Canonical Stream ---\n")
    test_canonical_stream(agent, input)

    # Test 4: Full run_agent with reducer
    IO.puts("\n--- Test 4: Full run_agent (with Reducer) ---\n")
    test_run_agent(agent, input)

    # Test 5: Event verification
    IO.puts("\n--- Test 5: Event Verification ---\n")
    test_event_verification(agent, input)

    IO.puts("\n=== All Tests Completed ===\n")
  end

  defp test_raw_stream(agent, input) do
    case HttpAgent.stream_raw(agent, input) do
      {:ok, stream} ->
        events = Enum.to_list(stream)
        IO.puts("Received #{length(events)} raw SSE events")

        Enum.each(events, fn event ->
          data = String.slice(event.data, 0, 80)
          suffix = if byte_size(event.data) > 80, do: "...", else: ""
          IO.puts("  [#{event.type}] #{data}#{suffix}")
        end)

        :ok

      {:error, reason} ->
        IO.puts("ERROR: #{inspect(reason)}")
        :error
    end
  end

  defp test_decoded_stream(agent, input) do
    case HttpAgent.stream(agent, input) do
      {:ok, stream} ->
        events = Enum.to_list(stream)
        IO.puts("Received #{length(events)} decoded events\n")

        # Group events by type
        by_type = Enum.group_by(events, fn e -> e.type end)

        IO.puts("Event breakdown:")

        by_type
        |> Enum.sort_by(fn {type, _} -> type end)
        |> Enum.each(fn {type, evts} ->
          IO.puts("  #{type}: #{length(evts)}")
        end)

        # Validate expected events
        IO.puts("\nValidation:")
        validate_has_event(events, :run_started, "RUN_STARTED")
        validate_has_event(events, :run_finished, "RUN_FINISHED")
        validate_has_event(events, :text_message_start, "TEXT_MESSAGE_START")
        validate_has_event(events, :text_message_end, "TEXT_MESSAGE_END")

        :ok

      {:error, reason} ->
        IO.puts("ERROR: #{inspect(reason)}")
        :error
    end
  end

  defp test_canonical_stream(agent, input) do
    case HttpAgent.stream_canonical(agent, input) do
      {:ok, stream} ->
        events = Enum.to_list(stream)
        IO.puts("Received #{length(events)} canonical events")

        # Check that chunk events were expanded
        chunk_count =
          Enum.count(events, fn e ->
            e.type in [:text_message_chunk, :tool_call_chunk]
          end)

        IO.puts("Chunk events after normalization: #{chunk_count} (should be 0)")

        # Print text message assembly
        IO.puts("\nStreamed text content:")

        events
        |> Enum.filter(&match?(%TextMessageContent{}, &1))
        |> Enum.each(fn e ->
          IO.write(e.delta)
        end)

        IO.puts("\n")

        :ok

      {:error, reason} ->
        IO.puts("ERROR: #{inspect(reason)}")
        :error
    end
  end

  defp test_run_agent(agent, input) do
    case HttpAgent.run_agent(agent, input) do
      {:ok, result} ->
        IO.puts("Run completed successfully!")
        IO.puts("")
        IO.puts("Result: #{inspect(result.result)}")
        IO.puts("New messages: #{length(result.new_messages)}")
        IO.puts("")

        IO.puts("Session state:")
        IO.puts("  Status: #{result.session.status}")
        IO.puts("  Messages: #{length(result.session.messages)}")
        IO.puts("  State keys: #{inspect(Map.keys(result.session.state))}")
        IO.puts("")

        # Show new messages
        IO.puts("New messages added:")

        Enum.each(result.new_messages, fn msg ->
          content =
            case msg do
              %{content: c} when is_binary(c) ->
                c |> String.slice(0, 50)

              %{tool_calls: [tc | _]} ->
                "Tool call: #{tc.function.name}"

              _ ->
                "(complex content)"
            end

          IO.puts("  [#{msg.role}] #{content}...")
        end)

        :ok

      {:error, reason} ->
        IO.puts("ERROR: #{inspect(reason)}")
        :error
    end
  end

  defp test_event_verification(agent, input) do
    case HttpAgent.stream_canonical(agent, input) do
      {:ok, stream} ->
        events = Enum.to_list(stream)

        # Run through verifier
        result =
          Enum.reduce_while(events, Verify.new(), fn event, verifier ->
            case Verify.verify_event(event, verifier) do
              {:ok, new_verifier} ->
                {:cont, new_verifier}

              {:error, reason} ->
                {:halt, {:error, reason, event}}
            end
          end)

        case result do
          {:error, reason, event} ->
            IO.puts("VERIFICATION FAILED!")
            IO.puts("  Reason: #{inspect(reason)}")
            IO.puts("  Event: #{inspect(event)}")
            :error

          %{} = verifier ->
            IO.puts("All events passed verification!")
            IO.puts("")
            IO.puts("Verifier state:")
            IO.puts("  Run status: #{verifier.run_status}")
            IO.puts("  Text open: #{MapSet.size(verifier.text_open)}")
            IO.puts("  Tool open: #{MapSet.size(verifier.tool_open)}")
            IO.puts("  Active steps: #{MapSet.size(verifier.active_steps)}")
            :ok
        end

      {:error, reason} ->
        IO.puts("ERROR: #{inspect(reason)}")
        :error
    end
  end

  defp validate_has_event(events, type, name) do
    if Enum.any?(events, fn e -> e.type == type end) do
      IO.puts("  [OK] #{name} present")
    else
      IO.puts("  [FAIL] #{name} missing!")
    end
  end
end

# Parse command line args
url =
  case System.argv() do
    [url | _] -> url
    [] -> "http://localhost:4001/agent"
  end

# Run the test client
AgUITestClient.run(url)
