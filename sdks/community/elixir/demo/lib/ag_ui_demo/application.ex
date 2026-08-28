defmodule AgUiDemo.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      AgUiDemoWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:ag_ui_demo, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: AgUiDemo.PubSub},
      # Start a worker by calling: AgUiDemo.Worker.start_link(arg)
      # {AgUiDemo.Worker, arg},
      # Start to serve requests, typically the last entry
      AgUiDemoWeb.Endpoint
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: AgUiDemo.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    AgUiDemoWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
