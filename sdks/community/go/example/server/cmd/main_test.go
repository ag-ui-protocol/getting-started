package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
	"github.com/gofiber/fiber/v3"
)

func testApp() *fiber.App {
	return newApp(context.Background(), config.Config{
		Host:      "127.0.0.1",
		Port:      8080,
		Provider:  "openai",
		Model:     "test-model",
		Workspace: ".",
		CORS:      true,
		GenUIPace: time.Millisecond,
	}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestAppHealthRouteNoCredentials(t *testing.T) {
	resp, err := testApp().Test(newRequest(t, http.MethodGet, "/", ""))
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, body = %s", resp.StatusCode, body)
	}
	for _, want := range []string{"ag-ui-go-server-example is running", "/agentic_chat", "/backend_tool_rendering", "/agentic_chat_multimodal"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("GET / body missing %q: %s", want, body)
		}
	}
}

func TestAppRouteRegistrationMalformedJSON(t *testing.T) {
	for _, route := range []string{
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
	} {
		t.Run(route, func(t *testing.T) {
			resp, err := testApp().Test(newRequest(t, http.MethodPost, route, "{"))
			if err != nil {
				t.Fatalf("POST %s: %v", route, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusNotFound {
				t.Fatalf("POST %s returned 404", route)
			}
			if resp.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("POST %s status = %d, want 400; body = %s", route, resp.StatusCode, body)
			}
		})
	}
}

func TestAppCORSAllowsApprovalHeader(t *testing.T) {
	req := newRequest(t, http.MethodOptions, "/human_in_the_loop", "")
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "X-AG-Approval")

	resp, err := testApp().Test(req)
	if err != nil {
		t.Fatalf("OPTIONS /human_in_the_loop: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("preflight status = %d, body = %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "x-ag-approval") {
		t.Fatalf("Access-Control-Allow-Headers = %q, want X-AG-Approval", got)
	}
}

func TestAppValidSSELifecycleNoCredentials(t *testing.T) {
	body := `{"threadId":"t","runId":"r","messages":[{"id":"u1","role":"user","content":"Plan dinner"}],"tools":[],"context":[],"forwardedProps":{},"state":{}}`
	resp, err := testApp().Test(newRequest(t, http.MethodPost, "/agentic_generative_ui", body))
	if err != nil {
		t.Fatalf("POST /agentic_generative_ui: %v", err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, out)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	for _, want := range []string{`"type":"RUN_STARTED"`, `"type":"RUN_FINISHED"`} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("SSE body missing %q: %s", want, out)
		}
	}
}

func newRequest(t *testing.T, method, path, body string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}
