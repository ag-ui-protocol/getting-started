package agent

import (
	"context"
	"fmt"
	"os"

	openaimodel "github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
)

// NewModel constructs the eino chat model for the configured provider.
//
//   - "openai": a plain OPENAI_API_KEY harness (Chat Completions).
//
// The standalone source example also had a prototype subscription provider
// backed by local replace directives. This monorepo example keeps only the
// reproducible provider path.
func NewModel(ctx context.Context, cfg config.Config) (model.ToolCallingChatModel, error) {
	switch cfg.Provider {
	case "openai", "":
		key := os.Getenv("OPENAI_API_KEY")
		if key == "" {
			return nil, fmt.Errorf("openai provider requires OPENAI_API_KEY")
		}
		return openaimodel.NewChatModel(ctx, &openaimodel.ChatModelConfig{
			APIKey: key,
			Model:  cfg.Model,
		})
	default:
		return nil, fmt.Errorf("unknown MODEL_PROVIDER %q (want openai)", cfg.Provider)
	}
}
