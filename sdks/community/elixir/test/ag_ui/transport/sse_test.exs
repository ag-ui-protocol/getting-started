defmodule AgUI.Transport.SSETest do
  use ExUnit.Case, async: true

  alias AgUI.Transport.SSE

  describe "new/0" do
    test "creates empty parser state" do
      parser = SSE.new()
      assert parser.buffer == ""
      assert parser.data_lines == []
      assert parser.last_event_id == nil
    end
  end

  describe "feed/2" do
    test "parses simple data event" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data: hello\n\n")

      assert length(events) == 1
      assert hd(events).data == "hello"
      assert hd(events).type == "message"
    end

    test "parses event with explicit type" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "event: custom\ndata: payload\n\n")

      assert length(events) == 1
      assert hd(events).type == "custom"
      assert hd(events).data == "payload"
    end

    test "parses event with id" do
      parser = SSE.new()
      {events, parser} = SSE.feed(parser, "id: 123\ndata: test\n\n")

      assert length(events) == 1
      assert hd(events).id == "123"
      assert SSE.last_event_id(parser) == "123"
    end

    test "parses event with retry" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "retry: 5000\ndata: test\n\n")

      assert length(events) == 1
      assert hd(events).retry == 5000
    end

    test "ignores invalid retry values" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "retry: invalid\ndata: test\n\n")

      assert length(events) == 1
      assert hd(events).retry == nil
    end

    test "handles multi-line data" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data: line1\ndata: line2\ndata: line3\n\n")

      assert length(events) == 1
      assert hd(events).data == "line1\nline2\nline3"
    end

    test "handles CRLF line endings" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data: hello\r\n\r\n")

      assert length(events) == 1
      assert hd(events).data == "hello"
    end

    test "handles mixed CRLF and LF line endings" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data: hello\r\ndata: world\n\n")

      assert length(events) == 1
      assert hd(events).data == "hello\nworld"
    end

    test "ignores comment lines" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, ": this is a comment\ndata: hello\n\n")

      assert length(events) == 1
      assert hd(events).data == "hello"
    end

    test "ignores unknown fields" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "unknown: value\ndata: hello\n\n")

      assert length(events) == 1
      assert hd(events).data == "hello"
    end

    test "handles field with no value" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data\n\n")

      assert length(events) == 1
      assert hd(events).data == ""
    end

    test "removes single leading space from values" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data: hello\n\n")

      assert hd(events).data == "hello"
    end

    test "preserves multiple leading spaces" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data:  hello\n\n")

      assert hd(events).data == " hello"
    end

    test "handles empty data line" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data:\n\n")

      assert length(events) == 1
      assert hd(events).data == ""
    end

    test "does not dispatch event without data" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "event: test\n\n")

      assert events == []
    end

    test "parses multiple events" do
      parser = SSE.new()
      {events, _parser} = SSE.feed(parser, "data: first\n\ndata: second\n\n")

      assert length(events) == 2
      assert Enum.at(events, 0).data == "first"
      assert Enum.at(events, 1).data == "second"
    end

    test "buffers incomplete events" do
      parser = SSE.new()
      {events1, parser} = SSE.feed(parser, "data: hel")

      assert events1 == []
      assert parser.buffer == "data: hel"

      {events2, _parser} = SSE.feed(parser, "lo\n\n")

      assert length(events2) == 1
      assert hd(events2).data == "hello"
    end

    test "buffers across multiple chunks" do
      parser = SSE.new()
      {events1, parser} = SSE.feed(parser, "data: ")
      assert events1 == []

      {events2, parser} = SSE.feed(parser, "hello")
      assert events2 == []

      {events3, parser} = SSE.feed(parser, "\n")
      assert events3 == []

      {events4, _parser} = SSE.feed(parser, "\n")
      assert length(events4) == 1
      assert hd(events4).data == "hello"
    end

    test "handles UTF-8 boundary splits" do
      payload = ~s(data: {"text":"é"}\n\n)
      bytes = :erlang.iolist_to_binary(payload)

      {idx, 2} = :binary.match(bytes, "é")
      chunk1 = :binary.part(bytes, 0, idx + 1)
      chunk2 = :binary.part(bytes, idx + 1, byte_size(bytes) - idx - 1)

      parser = SSE.new()
      {events1, parser} = SSE.feed(parser, chunk1)
      assert events1 == []

      {events2, _parser} = SSE.feed(parser, chunk2)
      assert length(events2) == 1
      assert hd(events2).data == "{\"text\":\"é\"}"
    end

    test "handles large data payloads" do
      large = String.duplicate("a", 200_000)
      parser = SSE.new()

      {events, _parser} = SSE.feed(parser, "data: #{large}\n\n")

      assert length(events) == 1
      assert hd(events).data == large
    end

    test "preserves last_event_id across events" do
      parser = SSE.new()
      {_events1, parser} = SSE.feed(parser, "id: 1\ndata: first\n\n")
      {events2, parser} = SSE.feed(parser, "data: second\n\n")

      # Second event should inherit the ID
      assert SSE.last_event_id(parser) == "1"
      assert hd(events2).id == "1"
    end

    test "updates last_event_id when new id received" do
      parser = SSE.new()
      {_events1, parser} = SSE.feed(parser, "id: 1\ndata: first\n\n")
      {events2, parser} = SSE.feed(parser, "id: 2\ndata: second\n\n")

      assert SSE.last_event_id(parser) == "2"
      assert hd(events2).id == "2"
    end

    test "ignores id with NULL character" do
      parser = SSE.new()
      {_events, parser} = SSE.feed(parser, "id: has\x00null\ndata: test\n\n")

      assert SSE.last_event_id(parser) == nil
    end

    test "resets event type after dispatch" do
      parser = SSE.new()
      {events1, parser} = SSE.feed(parser, "event: custom\ndata: first\n\n")
      {events2, _parser} = SSE.feed(parser, "data: second\n\n")

      assert hd(events1).type == "custom"
      assert hd(events2).type == "message"
    end
  end

  describe "finalize/1" do
    test "returns empty for empty parser" do
      parser = SSE.new()
      {events, _parser} = SSE.finalize(parser)
      assert events == []
    end

    test "dispatches pending event" do
      parser = SSE.new()
      {[], parser} = SSE.feed(parser, "data: incomplete")
      {events, _parser} = SSE.finalize(parser)

      assert length(events) == 1
      assert hd(events).data == "incomplete"
    end

    test "handles pending data lines" do
      parser = SSE.new()
      parser = %{parser | data_lines: ["line1", "line2"]}
      {events, _parser} = SSE.finalize(parser)

      assert length(events) == 1
      assert hd(events).data == "line1\nline2"
    end
  end

  describe "stream_events/2" do
    test "streams events from chunks" do
      chunks = ["data: first\n\n", "data: second\n\n"]

      events =
        chunks
        |> SSE.stream_events()
        |> Enum.to_list()

      assert length(events) == 2
      assert Enum.at(events, 0).data == "first"
      assert Enum.at(events, 1).data == "second"
    end

    test "handles chunked data" do
      chunks = ["data: hel", "lo\n\n"]

      events =
        chunks
        |> SSE.stream_events()
        |> Enum.to_list()

      assert length(events) == 1
      assert hd(events).data == "hello"
    end

    test "finalizes stream properly" do
      chunks = ["data: pending"]

      events =
        chunks
        |> SSE.stream_events()
        |> Enum.to_list()

      assert length(events) == 1
      assert hd(events).data == "pending"
    end
  end

  describe "decode_events/1" do
    test "decodes complete body" do
      body = "data: event1\n\ndata: event2\n\n"
      events = SSE.decode_events(body)

      assert length(events) == 2
      assert Enum.at(events, 0).data == "event1"
      assert Enum.at(events, 1).data == "event2"
    end

    test "handles body without trailing newlines" do
      body = "data: event"
      events = SSE.decode_events(body)

      assert length(events) == 1
      assert hd(events).data == "event"
    end
  end

  describe "JSON data parsing" do
    test "parses JSON in data field" do
      parser = SSE.new()
      json_data = ~s({"type": "RUN_STARTED", "threadId": "t1", "runId": "r1"})
      {events, _parser} = SSE.feed(parser, "data: #{json_data}\n\n")

      assert length(events) == 1
      {:ok, parsed} = Jason.decode(hd(events).data)
      assert parsed["type"] == "RUN_STARTED"
    end

    test "handles multi-line JSON" do
      parser = SSE.new()

      input = """
      data: {
      data:   "type": "TEST",
      data:   "value": 123
      data: }

      """

      {events, _parser} = SSE.feed(parser, input)

      assert length(events) == 1
      {:ok, parsed} = Jason.decode(hd(events).data)
      assert parsed["type"] == "TEST"
      assert parsed["value"] == 123
    end
  end
end
