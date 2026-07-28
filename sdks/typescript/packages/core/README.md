# @ag-ui/core

TypeScript definitions & runtime schemas for the **Agent-User Interaction (AG-UI) Protocol**.

`@ag-ui/core` delivers the strongly-typed building blocks that every other AG-UI package is built on: message & state models, run inputs and the full set of streaming event types.

## Installation

```bash
npm install @ag-ui/core
pnpm add @ag-ui/core
yarn add @ag-ui/core
```

The main entry has **zero runtime dependencies**. If you also want the zod schemas
and validating event factories from the `@ag-ui/core/schemas` subpath, install zod
yourself — it is an optional peer dependency accepting `^3.25.18 || ^4.0.0`:

```bash
npm install zod
```

## Features

- 🧩 **Typed data models** – `Message`, `Tool`, `Context`, `RunAgentInput`, `State` …
- 🔄 **Streaming events** – 16 core event kinds covering assistant messages, tool calls, state updates and run lifecycle.
- ✅ **Opt-in runtime validation** – zod schemas at `@ag-ui/core/schemas` catch malformed payloads early, on either zod major.
- 🪶 **Zero dependencies on the main entry** – types only, so consumers who validate with something else (or not at all) pay nothing.
- 🚀 **Framework-agnostic** – works in Node.js, browsers and any agent framework that can emit JSON.

## Quick example

```ts
import type { TextMessageContentEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";

// Construct a typed event — no zod, no runtime dependency
const event: TextMessageContentEvent = {
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg_123",
  delta: "Hello, world!",
};
```

Opt into runtime validation via the subpath. The factories validate their input, so
a malformed payload throws where it was produced rather than downstream:

```ts
import { EventSchemas, createTextMessageContentEvent } from "@ag-ui/core/schemas";

const validated = createTextMessageContentEvent({
  messageId: "msg_123",
  delta: "Hello, world!",
});

// Validate an untrusted payload off the wire
declare const rawJson: string;
const parsed = EventSchemas.parse(JSON.parse(rawJson));
```

> **Upgrading from 0.0.x?** The `*Schema` exports and `create*Event` factories moved
> from `@ag-ui/core` to `@ag-ui/core/schemas`. See the
> [0.1.0 migration guide](https://docs.ag-ui.com/sdk/js/core/migration-0-1-0).

## Documentation

- Concepts & architecture: [`docs/concepts`](https://docs.ag-ui.com/concepts/architecture)
- Full API reference: [`docs/sdk/js/core`](https://docs.ag-ui.com/sdk/js/core/overview)

## Contributing

Bug reports and pull requests are welcome! Please read our [contributing guide](https://docs.ag-ui.com/development/contributing) first.

## License

MIT © 2025 AG-UI Protocol Contributors
