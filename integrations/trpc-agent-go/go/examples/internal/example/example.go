package example

import (
	"trpc.group/trpc-go/trpc-agent-go/agent"
	"trpc.group/trpc-go/trpc-agent-go/server/agui"
)

// Spec describes an example mounted by the shared server.
type Spec struct {
	Name          string
	Agent         agent.Agent
	ServerOptions []agui.Option
}
