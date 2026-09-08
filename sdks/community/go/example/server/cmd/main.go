// Command server is a Fiber v3 implementation of the AG-UI protocol backed by an
// eino agent loop. The agent streams the full AG-UI event surface and can read
// (never write) files via a single read-only file_read tool.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/cors"
	"github.com/gofiber/fiber/v3/middleware/requestid"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/agent"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/audio"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/document"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/imagegen"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/vision"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg := config.Load()
	ctx := context.Background()

	if cfg.MaxIterations <= 0 {
		logger.Warn("AGENT_MAX_ITERATIONS is <= 0; using the default per-run iteration budget",
			"configured", cfg.MaxIterations, "default", config.DefaultMaxIterations)
	}

	if os.Getenv("AGENT_WORKSPACE") == "" {
		logger.Warn("AGENT_WORKSPACE is unset; the read-only file_read tool is rooted at the "+
			"process working directory — set it deliberately to bound what the agent can read",
			"workspace", cfg.Workspace)
	}

	base, err := agent.NewModel(ctx, cfg)
	if err != nil {
		logger.Error("failed to construct chat model", "provider", cfg.Provider, "error", err)
		fmt.Fprintln(os.Stderr, "\nHint: set OPENAI_API_KEY or use a supported MODEL_PROVIDER.")
		os.Exit(1)
	}

	tools, err := agent.NewReadOnlyToolset(cfg.Workspace)
	if err != nil {
		logger.Error("failed to build toolset", "workspace", cfg.Workspace, "error", err)
		os.Exit(1)
	}

	// boundModel is shared across all concurrent /agentic requests. This is safe
	// because eino's ToolCallingChatModel.Stream is stateless per call (it takes
	// the messages as an argument and returns a fresh StreamReader). A future
	// provider that caches per-instance state would need a per-request clone or pool.
	boundModel, err := base.WithTools(tools.Infos())
	if err != nil {
		logger.Error("failed to bind tools", "error", err)
		os.Exit(1)
	}

	deps := &agent.Deps{
		Model:         boundModel,
		BaseModel:     base,
		Tools:         tools,
		Store:         runstore.New(),
		AutoApprove:   cfg.AutoApprove,
		MaxIterations: cfg.MaxIterations,
		Logger:        logger,
		Provider:      cfg.Provider,
	}

	// Graceful shutdown: on SIGINT/SIGTERM, Fiber stops accepting connections and
	// lets in-flight SSE runs drain (up to ShutdownTimeout) instead of being killed.
	// sigCtx is also threaded into the handlers so a shutdown cancels the run
	// context of in-flight requests, aborting model streams promptly.
	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app := newApp(sigCtx, cfg, deps, logger)

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	logger.Info("starting server", "addr", addr, "provider", cfg.Provider, "model", cfg.Model,
		"workspace", cfg.Workspace, "autoApprove", cfg.AutoApprove)
	if err := app.Listen(addr, fiber.ListenConfig{
		GracefulContext: sigCtx,
		ShutdownTimeout: 10 * time.Second,
	}); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func newApp(shutdownCtx context.Context, cfg config.Config, deps *agent.Deps, logger *slog.Logger) *fiber.App {
	app := fiber.New(fiber.Config{AppName: "ag-ui-go-server-example", BodyLimit: 20 * 1024 * 1024})
	app.Use(requestid.New())
	if cfg.CORS {
		app.Use(cors.New(cors.Config{
			AllowOrigins: []string{"*"},
			AllowMethods: []string{"GET", "POST", "OPTIONS"},
			AllowHeaders: []string{"Origin", "Content-Type", "Accept", "Cache-Control", "X-AG-Approval"},
		}))
	}

	app.Get("/", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"message":     "ag-ui-go-server-example is running",
			"provider":    cfg.Provider,
			"model":       cfg.Model,
			"workspace":   cfg.Workspace,
			"autoApprove": cfg.AutoApprove,
			"routes": []string{
				"/agentic",
				"/agentic_chat",
				"/backend_tool_rendering",
				"/human_in_the_loop",
				"/agentic_generative_ui",
				"/tool_based_generative_ui",
				"/shared_state",
				"/predictive_state_updates",
				"/agentic_chat_multimodal",
				"/image-gen",
				"/vision",
				"/audio",
				"/document",
			},
		})
	})

	app.Post("/agentic", agenticHandler(shutdownCtx, deps, logger))
	app.Post("/image-gen", imagegen.Handler(shutdownCtx, logger))
	app.Post("/vision", vision.Handler(shutdownCtx, logger))
	app.Post("/audio", audio.Handler(shutdownCtx, logger))
	app.Post("/document", document.Handler(shutdownCtx, logger))

	// Dojo feature-parity routes. The path strings are a fixed contract the Dart
	// SDK binds to. Each supplies only its run function to the shared streamHandler.
	app.Post("/agentic_generative_ui", streamHandler(shutdownCtx, logger, "agentic_generative_ui",
		agent.AgenticGenerativeUI{Pace: cfg.GenUIPace}.Run))
	app.Post("/agentic_chat", streamHandler(shutdownCtx, logger, "agentic_chat",
		func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
			agent.Run(ctx, emit, in, deps, agent.AgenticChatConfig(), threadID, runID)
		}))
	app.Post("/backend_tool_rendering", streamHandler(shutdownCtx, logger, "backend_tool_rendering",
		func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
			agent.Run(ctx, emit, in, deps, agent.AgenticChatConfig(), threadID, runID)
		}))
	app.Post("/tool_based_generative_ui", streamHandler(shutdownCtx, logger, "tool_based_generative_ui",
		func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
			agent.Run(ctx, emit, in, deps, agent.ToolBasedGenerativeUIConfig(), threadID, runID)
		}))
	app.Post("/shared_state", streamHandler(shutdownCtx, logger, "shared_state",
		agent.SharedState{Deps: deps}.Run))
	app.Post("/predictive_state_updates", streamHandler(shutdownCtx, logger, "predictive_state_updates",
		agent.PredictiveState{Deps: deps}.Run))
	app.Post("/agentic_chat_multimodal", streamHandler(shutdownCtx, logger, "agentic_chat_multimodal",
		func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
			agent.Run(ctx, emit, in, deps, agent.AgenticChatConfig(), threadID, runID)
		}))
	// /human_in_the_loop reads its per-request approval toggle from the request
	// (header/query) before streaming, so it registers a thin handler that resolves
	// the config and delegates to the shared streamRun.
	hilSW := sse.NewSSEWriter().WithLogger(logger)
	app.Post("/human_in_the_loop", func(c fiber.Ctx) error {
		cfg := agent.HumanInTheLoopConfig(approvalMode(c))
		return streamRun(c, shutdownCtx, logger, hilSW, "human_in_the_loop",
			func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
				agent.Run(ctx, emit, in, deps, cfg, threadID, runID)
			})
	})

	return app
}

// streamHandler is the shared SSE-handler boilerplate for the feature routes:
// it parses the RunAgentInput, defaults the thread/run IDs, sets the SSE headers,
// wires an Emitter onto a shutdown-derived run context, recovers a panic into a
// RUN_ERROR, and invokes the route's run function. Each route supplies only `run`.
func streamHandler(shutdownCtx context.Context, logger *slog.Logger, name string,
	run func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string)) fiber.Handler {
	sw := sse.NewSSEWriter().WithLogger(logger)
	return func(c fiber.Ctx) error {
		return streamRun(c, shutdownCtx, logger, sw, name, run)
	}
}

// streamRun is the inner SSE-handler body, shared by streamHandler and routes that
// must read request metadata (e.g. /human_in_the_loop reads its approval header)
// before the stream writer runs — the fiber.Ctx is recycled once the handler
// returns, so any header/query read must happen synchronously here, not inside the
// stream-writer closure.
func streamRun(c fiber.Ctx, shutdownCtx context.Context, logger *slog.Logger, sw *sse.SSEWriter, name string,
	run func(ctx context.Context, emit *agent.Emitter, in *aguitypes.RunAgentInput, threadID, runID string)) error {
	var in aguitypes.RunAgentInput
	if err := json.Unmarshal(c.Body(), &in); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	threadID := in.ThreadID
	if threadID == "" {
		threadID = aguievents.GenerateThreadID()
	}
	runID := in.RunID
	if runID == "" {
		runID = aguievents.GenerateRunID()
	}

	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")

	return c.SendStreamWriter(func(w *bufio.Writer) {
		runCtx, cancel := context.WithCancel(shutdownCtx)
		defer cancel()
		emit := agent.NewEmitter(runCtx, w, sw, threadID, runID, cancel)
		defer func() {
			if r := recover(); r != nil {
				logger.Error("handler panicked", "route", name, "thread", threadID, "run", runID, "panic", r)
				emit.RunError("the agent crashed while handling this run")
			}
		}()
		run(runCtx, emit, &in, threadID, runID)
		if err := emit.Err(); err != nil {
			logger.Warn("event stream ended early", "route", name, "thread", threadID, "run", runID, "error", err)
		}
	})
}

// approvalMode reads the per-request approval toggle for /human_in_the_loop from
// the X-AG-Approval header, falling back to the ?approval= query param. The demo
// always sends forwardedProps:{}, so a header/query channel needs no demo-side
// send change. Empty (the default) keeps the approval gate on.
func approvalMode(c fiber.Ctx) string {
	if v := c.Get("X-AG-Approval"); v != "" {
		return v
	}
	return c.Query("approval")
}

func agenticHandler(shutdownCtx context.Context, deps *agent.Deps, logger *slog.Logger) fiber.Handler {
	sw := sse.NewSSEWriter().WithLogger(logger)
	return func(c fiber.Ctx) error {
		var in aguitypes.RunAgentInput
		if err := json.Unmarshal(c.Body(), &in); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		threadID := in.ThreadID
		if threadID == "" {
			threadID = aguievents.GenerateThreadID()
		}
		runID := in.RunID
		if runID == "" {
			runID = aguievents.GenerateRunID()
		}

		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		// CORS headers are owned by the cors middleware (gated by CORS_ENABLED), so
		// it stays the single source of truth. Setting Access-Control-Allow-Origin
		// here would duplicate it and force "*" even when CORS is disabled.

		return c.SendStreamWriter(func(w *bufio.Writer) {
			// Derive the run context from the shutdown context, not the fasthttp
			// RequestCtx: the stream writer runs after the handler returns (RequestCtx
			// is then recycled) and RequestCtx never signals client disconnect.
			// Parenting on shutdownCtx means a SIGINT/SIGTERM also cancels in-flight
			// runs, aborting the model stream instead of leaking it until the drain
			// deadline. The emitter additionally cancels this context on the first
			// failed write, aborting the stream when the client goes away.
			runCtx, cancel := context.WithCancel(shutdownCtx)
			defer cancel()
			emit := agent.NewEmitter(runCtx, w, sw, threadID, runID, cancel)
			// A panic inside the agent loop (provider bug, nil deref) would otherwise
			// unwind through the stream-writer goroutine and truncate the stream with
			// no terminal event. Turn it into a RUN_ERROR instead.
			defer func() {
				if r := recover(); r != nil {
					logger.Error("agent panicked", "thread", threadID, "run", runID, "panic", r)
					emit.RunError("the agent crashed while handling this run")
				}
			}()
			agent.Run(runCtx, emit, &in, deps, agent.DefaultRunConfig(), threadID, runID)
			if err := emit.Err(); err != nil {
				logger.Warn("event stream ended early", "thread", threadID, "run", runID, "error", err)
			}
		})
	}
}
