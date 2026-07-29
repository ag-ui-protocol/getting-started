import { HttpAgent } from "@ag-ui/client";

// Thin HttpAgent subclass for AG-UI clients pointing at a Hermes AG-UI adapter
// endpoint. No maxVersion override: Hermes speaks the current AG-UI protocol
// (parentRunId, REASONING_MESSAGE_*), so it inherits HttpAgent's default
// (latest) version rather than pinning to an older one.
export class HermesAgent extends HttpAgent {}
