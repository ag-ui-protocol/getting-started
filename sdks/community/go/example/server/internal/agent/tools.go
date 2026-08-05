package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

// Toolset is the agent's tool registry.
//
// NO-FILE-WRITE POLICY: this agent must never modify the filesystem. Only the
// read-only local fileReadTool ("file_read") is registered. Do NOT add
// write/edit/shell tools here — the whole point of this server is a read-only
// agent. The workspace root further sandboxes reads to a single directory.
type Toolset struct {
	infos  []*schema.ToolInfo
	byName map[string]tool.InvokableTool
}

// NewReadOnlyToolset builds a registry containing only file_read, rooted at the
// given absolute workspace directory.
func NewReadOnlyToolset(workspace string) (*Toolset, error) {
	rt, err := newFileReadTool(workspace)
	if err != nil {
		return nil, fmt.Errorf("file_read tool: %w", err)
	}
	info, err := rt.Info(context.Background())
	if err != nil {
		return nil, fmt.Errorf("file_read info: %w", err)
	}
	return &Toolset{
		infos:  []*schema.ToolInfo{info},
		byName: map[string]tool.InvokableTool{info.Name: rt},
	}, nil
}

// Infos returns the tool schemas to bind to the chat model.
func (t *Toolset) Infos() []*schema.ToolInfo { return t.infos }

// Run executes a registered tool by name with JSON arguments.
func (t *Toolset) Run(ctx context.Context, name, argsJSON string) (string, error) {
	tl, ok := t.byName[name]
	if !ok {
		return "", fmt.Errorf("unknown or unpermitted tool %q (this agent only allows file_read)", name)
	}
	return tl.InvokableRun(ctx, argsJSON)
}

type fileReadTool struct {
	root string
	info *schema.ToolInfo
}

type fileReadArgs struct {
	Path string `json:"path"`
}

func newFileReadTool(workspace string) (*fileReadTool, error) {
	if workspace == "" {
		workspace = "."
	}
	abs, err := filepath.Abs(workspace)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &fileReadTool{
		root: root,
		info: &schema.ToolInfo{
			Name: "file_read",
			Desc: "Read a UTF-8 text file from the configured read-only workspace. Provide a relative path within the workspace.",
			ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
				"path": {
					Type:     schema.String,
					Desc:     "Relative path to read from the configured workspace.",
					Required: true,
				},
			}),
		},
	}, nil
}

func (t *fileReadTool) Info(_ context.Context) (*schema.ToolInfo, error) {
	return t.info, nil
}

func (t *fileReadTool) InvokableRun(_ context.Context, argsJSON string, _ ...tool.Option) (string, error) {
	var args fileReadArgs
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return "", fmt.Errorf("invalid file_read arguments: %w", err)
	}
	if strings.TrimSpace(args.Path) == "" {
		return "", fmt.Errorf("path is required")
	}
	if filepath.IsAbs(args.Path) {
		return "", fmt.Errorf("path must be relative to the configured workspace")
	}

	target := filepath.Join(t.root, filepath.Clean(args.Path))
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(t.root, resolved)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes the configured workspace")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory")
	}
	b, err := os.ReadFile(resolved)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
