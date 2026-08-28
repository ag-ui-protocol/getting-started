defmodule AgUI.MixProject do
  use Mix.Project

  @version "0.1.0"
  @source_url "https://github.com/ag-ui-protocol/ag-ui"

  def project do
    [
      app: :ag_ui,
      version: @version,
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      docs: docs(),
      description: "Elixir SDK for the AG-UI (Agent-User Interaction) Protocol",
      package: package(),
      source_url: @source_url
    ]
  end

  def application do
    [
      extra_applications: [:logger]
    ]
  end

  defp deps do
    [
      # Core
      {:jason, "~> 1.4"},
      {:req, "~> 0.5"},
      {:jsonpatch, "~> 2.3"},

      # Optional Phoenix / LiveView integration
      {:phoenix, "~> 1.7", optional: true},
      {:phoenix_live_view, "~> 1.0", optional: true},
      {:phoenix_html, "~> 4.0", optional: true},

      # Dev/test
      {:ex_doc, "~> 0.34", only: :dev, runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false},
      {:bandit, "~> 1.5", only: :test},
      {:plug, "~> 1.16", optional: true}
    ]
  end

  defp docs do
    [
      main: "AgUI",
      source_url: @source_url,
      extras: ["README.md"]
    ]
  end

  defp package do
    [
      licenses: ["MIT"],
      links: %{"GitHub" => @source_url}
    ]
  end
end
