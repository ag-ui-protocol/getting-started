# Agent User Interaction Protocol TypeScript SDK

The TypeScript SDK for the [Agent User Interaction Protocol](https://ag-ui.com).

For more information visit the [official documentation](https://docs.ag-ui.com/).

## Multimodal user messages

```ts
import type { UserMessage } from "@ag-ui/core";

const message: UserMessage = {
  id: "user-123",
  role: "user",
  content: [
    { type: "text", text: "Please describe this image" },
    {
      type: "image",
      source: {
        type: "url",
        value: "https://example.com/cat.png",
        mimeType: "image/png",
      },
    },
  ],
};

console.log(message);
// { id: "user-123", role: "user", content: [...] }
```
