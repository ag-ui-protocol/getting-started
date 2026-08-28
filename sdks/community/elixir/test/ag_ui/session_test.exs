defmodule AgUI.SessionTest do
  use ExUnit.Case, async: true

  alias AgUI.Session
  alias AgUI.Types.Message

  describe "new/0" do
    test "creates empty session" do
      session = Session.new()
      assert session.status == :idle
      assert session.thread_id == nil
      assert session.run_id == nil
      assert session.messages == []
      assert session.state == %{}
      assert session.steps == []
      assert session.text_buffers == %{}
      assert session.tool_buffers == %{}
      assert session.thinking == %{active: false, content: ""}
    end
  end

  describe "new/1" do
    test "creates session with thread ID" do
      session = Session.new("thread-123")
      assert session.thread_id == "thread-123"
      assert session.run_id == nil
      assert session.status == :idle
    end
  end

  describe "new/2" do
    test "creates session with thread and run ID" do
      session = Session.new("thread-123", "run-456")
      assert session.thread_id == "thread-123"
      assert session.run_id == "run-456"
    end
  end

  describe "running?/1" do
    test "returns true when status is :running" do
      session = %Session{status: :running}
      assert Session.running?(session)
    end

    test "returns false for other statuses" do
      assert not Session.running?(%Session{status: :idle})
      assert not Session.running?(%Session{status: :finished})
      assert not Session.running?(%Session{status: {:error, "oops"}})
    end
  end

  describe "finished?/1" do
    test "returns true when status is :finished" do
      session = %Session{status: :finished}
      assert Session.finished?(session)
    end

    test "returns false for other statuses" do
      assert not Session.finished?(%Session{status: :idle})
      assert not Session.finished?(%Session{status: :running})
      assert not Session.finished?(%Session{status: {:error, "oops"}})
    end
  end

  describe "error?/1" do
    test "returns true when status is {:error, _}" do
      session = %Session{status: {:error, "something went wrong"}}
      assert Session.error?(session)
    end

    test "returns false for other statuses" do
      assert not Session.error?(%Session{status: :idle})
      assert not Session.error?(%Session{status: :running})
      assert not Session.error?(%Session{status: :finished})
    end
  end

  describe "error_message/1" do
    test "returns error message when in error state" do
      session = %Session{status: {:error, "something went wrong"}}
      assert Session.error_message(session) == "something went wrong"
    end

    test "returns nil for non-error states" do
      assert Session.error_message(%Session{status: :idle}) == nil
      assert Session.error_message(%Session{status: :running}) == nil
      assert Session.error_message(%Session{status: :finished}) == nil
    end
  end

  describe "streaming?/1" do
    test "returns true when text buffers are not empty" do
      session = %Session{text_buffers: %{"msg-1" => %{content: "Hello", role: :assistant}}}
      assert Session.streaming?(session)
    end

    test "returns true when tool buffers are not empty" do
      session = %Session{
        tool_buffers: %{"call-1" => %{name: "search", args: "{}", parent_message_id: nil}}
      }

      assert Session.streaming?(session)
    end

    test "returns false when both buffers are empty" do
      session = Session.new()
      assert not Session.streaming?(session)
    end
  end

  describe "streaming_text/2" do
    test "returns content for existing buffer" do
      session = %Session{text_buffers: %{"msg-1" => %{content: "Hello world", role: :assistant}}}
      assert Session.streaming_text(session, "msg-1") == "Hello world"
    end

    test "returns nil for non-existent buffer" do
      session = Session.new()
      assert Session.streaming_text(session, "msg-1") == nil
    end
  end

  describe "streaming_tool_args/2" do
    test "returns args for existing buffer" do
      session = %Session{
        tool_buffers: %{
          "call-1" => %{name: "search", args: "{\"q\": \"test\"}", parent_message_id: nil}
        }
      }

      assert Session.streaming_tool_args(session, "call-1") == "{\"q\": \"test\"}"
    end

    test "returns nil for non-existent buffer" do
      session = Session.new()
      assert Session.streaming_tool_args(session, "call-1") == nil
    end
  end

  describe "messages_by_role/2" do
    test "filters messages by role" do
      session = %Session{
        messages: [
          %Message.User{id: "1", content: "Hello"},
          %Message.Assistant{id: "2", content: "Hi there!"},
          %Message.User{id: "3", content: "How are you?"}
        ]
      }

      user_messages = Session.messages_by_role(session, :user)
      assert length(user_messages) == 2
      assert Enum.all?(user_messages, &(&1.role == :user))

      assistant_messages = Session.messages_by_role(session, :assistant)
      assert length(assistant_messages) == 1
    end

    test "returns empty list when no messages match" do
      session = %Session{
        messages: [
          %Message.User{id: "1", content: "Hello"}
        ]
      }

      assert Session.messages_by_role(session, :tool) == []
    end
  end

  describe "last_message/1" do
    test "returns the last message" do
      session = %Session{
        messages: [
          %Message.User{id: "1", content: "Hello"},
          %Message.Assistant{id: "2", content: "Hi there!"}
        ]
      }

      last = Session.last_message(session)
      assert last.id == "2"
    end

    test "returns nil for empty messages" do
      session = Session.new()
      assert Session.last_message(session) == nil
    end
  end

  describe "get_message/2" do
    test "returns message with matching ID" do
      session = %Session{
        messages: [
          %Message.User{id: "msg-1", content: "Hello"},
          %Message.Assistant{id: "msg-2", content: "Hi!"}
        ]
      }

      msg = Session.get_message(session, "msg-2")
      assert msg.id == "msg-2"
      assert msg.content == "Hi!"
    end

    test "returns nil when message not found" do
      session = Session.new()
      assert Session.get_message(session, "nonexistent") == nil
    end
  end

  describe "get_step/2" do
    test "returns step with matching name" do
      session = %Session{
        steps: [
          %{name: "search", status: :started},
          %{name: "analyze", status: :finished}
        ]
      }

      step = Session.get_step(session, "analyze")
      assert step.name == "analyze"
      assert step.status == :finished
    end

    test "returns nil when step not found" do
      session = Session.new()
      assert Session.get_step(session, "nonexistent") == nil
    end
  end

  describe "thinking?/1" do
    test "returns true when thinking is active" do
      session = %Session{thinking: %{active: true, content: "Hmm..."}}
      assert Session.thinking?(session)
    end

    test "returns false when thinking is not active" do
      session = Session.new()
      assert not Session.thinking?(session)
    end
  end

  describe "thinking_content/1" do
    test "returns thinking content" do
      session = %Session{thinking: %{active: true, content: "Let me think about this..."}}
      assert Session.thinking_content(session) == "Let me think about this..."
    end

    test "returns empty string for new session" do
      session = Session.new()
      assert Session.thinking_content(session) == ""
    end
  end
end
