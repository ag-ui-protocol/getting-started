// Package config loads server configuration from the environment.
package config

import (
	"os"
	"strconv"
	"time"
)

const (
	// DefaultMaxIterations bounds the model<->tool loop per run when unset/invalid.
	DefaultMaxIterations = 8
	// MaxIterationsCeiling caps AGENT_MAX_ITERATIONS so an accidental large value
	// can't run the (paid) model an unbounded number of times.
	MaxIterationsCeiling = 64
)

// Config holds the server's runtime configuration.
type Config struct {
	Host string
	Port int

	// Provider selects the eino chat-model backend. This monorepo example ships
	// the reproducible OpenAI provider path and avoids local/private providers.
	Provider string
	// Model is the model slug passed to the provider.
	Model string

	// Workspace is the absolute directory the read-only file_read tool is rooted at.
	// Defaults to the process working directory (override with AGENT_WORKSPACE);
	// since this is the root the agent can read, set it deliberately in real use.
	Workspace string
	// AutoApprove bypasses the human-in-the-loop tool-approval interrupt when true.
	AutoApprove bool
	// MaxIterations bounds the model<->tool loop per run (env AGENT_MAX_ITERATIONS).
	MaxIterations int
	// CORS enables permissive CORS for local UI development.
	CORS bool
	// GenUIPace is the delay between step transitions on /agentic_generative_ui
	// (env AGENTIC_UI_PACE_MS). A visible delay is the point of that demo; an
	// instantaneous run defeats it.
	GenUIPace time.Duration
}

// Load reads configuration from the environment, applying defaults.
func Load() Config {
	wd, _ := os.Getwd()
	provider := envOr("MODEL_PROVIDER", "openai")
	model := os.Getenv("MODEL")
	if model == "" {
		model = "gpt-4o"
	}
	port := envInt("PORT", 8080)
	if port < 1 || port > 65535 {
		port = 8080 // out-of-range value would otherwise fail late at Listen with an opaque error
	}
	return Config{
		Host:          envOr("HOST", "127.0.0.1"),
		Port:          port,
		Provider:      provider,
		Model:         model,
		Workspace:     envOr("AGENT_WORKSPACE", wd),
		AutoApprove:   envBool("AGENT_AUTO_APPROVE", false),
		MaxIterations: envInt("AGENT_MAX_ITERATIONS", DefaultMaxIterations),
		CORS:          envBool("CORS_ENABLED", true),
		GenUIPace:     time.Duration(envInt("AGENTIC_UI_PACE_MS", 600)) * time.Millisecond,
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
