package main

import (
	"net"
	"net/http"
	"os"
	"strings"

	agenticchat "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/agentic_chat"
	agenticchatmultimodal "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/agentic_chat_multimodal"
	agenticchatreasoning "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/agentic_chat_reasoning"
	agenticgenerativeui "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/agentic_generative_ui"
	backendtoolrendering "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/backend_tool_rendering"
	humanintheloop "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/human_in_the_loop"
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"
	predictivestateupdates "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/predictive_state_updates"
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/shared_state"
	toolbasedgenerativeui "github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/tool_based_generative_ui"

	"trpc.group/trpc-go/trpc-agent-go/log"
	trpcrunner "trpc.group/trpc-go/trpc-agent-go/runner"
	"trpc.group/trpc-go/trpc-agent-go/server/agui"
)

const (
	defaultPort = "8027"
	agentPath   = "/agui"
)

func main() {
	examples := []example.Spec{
		agenticchat.New(),
		agenticchatreasoning.New(),
		agenticchatmultimodal.New(),
		agenticgenerativeui.New(),
		backendtoolrendering.New(),
		humanintheloop.New(),
		predictivestateupdates.New(),
		sharedstate.New(),
		toolbasedgenerativeui.New(),
	}

	mux := http.NewServeMux()
	runners := make([]trpcrunner.Runner, 0, len(examples))
	defer func() {
		for _, agentRunner := range runners {
			if err := agentRunner.Close(); err != nil {
				log.Errorf("close runner: %v", err)
			}
		}
	}()

	for _, item := range examples {
		agentRunner := trpcrunner.NewRunner(item.Agent.Info().Name, item.Agent)
		serverOptions := append(
			[]agui.Option{agui.WithBasePath("/" + item.Name), agui.WithPath(agentPath)},
			item.ServerOptions...,
		)
		server, err := agui.New(agentRunner, serverOptions...)
		if err != nil {
			log.Fatalf("create %s AG-UI server: %v", item.Name, err)
		}
		runners = append(runners, agentRunner)
		mux.Handle("/"+item.Name+"/", server.Handler())
	}

	address := net.JoinHostPort("0.0.0.0", envOrDefault("PORT", defaultPort))
	paths := make([]string, 0, len(examples))
	for _, item := range examples {
		paths = append(paths, "/"+item.Name+agentPath)
	}
	log.Infof(
		"serving tRPC-Agent-Go AG-UI examples at http://%s: %s",
		address,
		strings.Join(paths, ", "),
	)
	if err := http.ListenAndServe(address, mux); err != nil {
		log.Fatalf("serve AG-UI examples: %v", err)
	}
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
