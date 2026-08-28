defmodule AgUI.LiveView do
  @moduledoc """
  Phoenix LiveView integration for AG-UI.

  This module provides tools for integrating AG-UI agents with Phoenix LiveView,
  enabling real-time streaming of agent responses to the browser.

  ## Overview

  The LiveView integration consists of:

  - `AgUI.LiveView.Renderer` - Pure Elixir UI state manager
  - `AgUI.LiveView.Runner` - GenServer that streams events to LiveView
  - `AgUI.LiveView.Helpers` - Convenience functions for common patterns

  ## Requirements

  This module requires `phoenix_live_view` to be installed. Add it to your deps:

      {:phoenix_live_view, "~> 1.0"}

  ## Quick Start

      defmodule MyAppWeb.ChatLive do
        use MyAppWeb, :live_view
        import AgUI.LiveView.Helpers

        def mount(_params, _session, socket) do
          {:ok, init_agui(socket)}
        end

        def handle_event("send_message", %{"message" => text}, socket) do
          input = %AgUI.Types.RunAgentInput{
            thread_id: "thread-1",
            run_id: UUID.uuid4(),
            messages: [%AgUI.Types.Message{role: :user, content: text}]
          }

          socket = start_agui_run(socket,
            agent: "http://localhost:4000/api/agent",
            input: input
          )

          {:noreply, socket}
        end

        def handle_info(msg, socket) do
          case handle_agui_message(msg, socket) do
            {:ok, socket} -> {:noreply, socket}
            :not_agui -> {:noreply, socket}
          end
        end

        def render(assigns) do
          ~H\"\"\"
          <div>
            <div :for={msg <- @agui.session.messages}>
              <strong><%= msg.role %>:</strong>
              <%= msg.content %>
            </div>

            <div :for={{_id, buffer} <- @agui.streaming_messages}>
              <em><%= buffer.content %></em>
            </div>
          </div>
          \"\"\"
        end
      end

  ## Without Helpers

  You can also use the lower-level modules directly:

      defmodule MyAppWeb.ChatLive do
        use MyAppWeb, :live_view

        alias AgUI.LiveView.{Renderer, Runner}
        alias AgUI.Client.HttpAgent

        def mount(_params, _session, socket) do
          {:ok, assign(socket, agui: Renderer.init(), runner: nil)}
        end

        def handle_event("send_message", %{"message" => text}, socket) do
          agent = HttpAgent.new(url: "http://localhost:4000/api/agent")
          input = %AgUI.Types.RunAgentInput{
            thread_id: "thread-1",
            run_id: UUID.uuid4(),
            messages: [%AgUI.Types.Message{role: :user, content: text}]
          }

          {:ok, runner} = Runner.start_link(
            liveview: self(),
            agent: agent,
            input: input
          )

          {:noreply, assign(socket, runner: runner)}
        end

        def handle_info({:agui, event}, socket) do
          agui = Renderer.apply(socket.assigns.agui, event)
          {:noreply, assign(socket, agui: agui)}
        end

        def handle_info({:agui, :done}, socket) do
          {:noreply, assign(socket, runner: nil)}
        end

        def handle_info({:agui, {:error, reason}}, socket) do
          {:noreply, put_flash(socket, :error, inspect(reason))}
        end
      end

  """

  @doc """
  Returns true if Phoenix LiveView is available.

  This checks if the required Phoenix LiveView modules are loaded.
  Use this to conditionally enable LiveView features.

  ## Examples

      if AgUI.LiveView.available?() do
        # Use LiveView integration
      else
        # Fall back to alternative
      end

  """
  @spec available?() :: boolean()
  def available? do
    Code.ensure_loaded?(Phoenix.LiveView) and
      Code.ensure_loaded?(Phoenix.LiveView.Socket)
  end

  @doc """
  Returns true if Phoenix HTML is available.

  This is useful for determining if HTML rendering helpers can be used.
  """
  @spec html_available?() :: boolean()
  def html_available? do
    Code.ensure_loaded?(Phoenix.HTML)
  end

  # Re-export main modules for convenience
  defdelegate init(opts \\ []), to: AgUI.LiveView.Renderer

  defdelegate apply_event(ui_state, event), to: AgUI.LiveView.Renderer

  defdelegate apply_all(ui_state, events), to: AgUI.LiveView.Renderer

  defdelegate running?(ui_state), to: AgUI.LiveView.Renderer

  defdelegate finished?(ui_state), to: AgUI.LiveView.Renderer

  defdelegate error?(ui_state), to: AgUI.LiveView.Renderer

  defdelegate messages(ui_state), to: AgUI.LiveView.Renderer

  defdelegate state(ui_state), to: AgUI.LiveView.Renderer

  defdelegate reset(ui_state), to: AgUI.LiveView.Renderer
end
