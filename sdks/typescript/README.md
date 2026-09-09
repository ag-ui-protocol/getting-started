# Agent User Interaction Protocol TypeScript SDK

The TypeScript SDK for the [Agent User Interaction Protocol](https://ag-ui.com).

For more information visit the [official documentation](https://docs.ag-ui.com/).

## Multimodal user messages

```ts
import { UserMessageSchema } from "@ag-ui/core/schemas";

const message = UserMessageSchema.parse({
  id: "user-123",
  role: "user" as const,
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
});

console.log(message);
// { id: "user-123", role: "user", content: [...] }
```
