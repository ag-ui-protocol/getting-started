/**
 * Langroid is a Python framework for building multi-agent AI systems.
 * Check more about using Langroid: https://github.com/langroid/langroid
 */

/**
 * STATUS: UNPUBLISHED ON PURPOSE.
 *
 * This package is currently a no-op: `LangroidHttpAgent` is an empty subclass
 * of `HttpAgent` that adds no behavior. Because it has nothing to offer over
 * `@ag-ui/client`'s `HttpAgent`, it is marked `"private": true` in package.json
 * and is intentionally NOT published to npm.
 *
 * To resolve this, pick ONE of the following:
 *
 *   1) MAKE IT PUBLISHABLE — give it a real capability surface.
 *      Mirror `@ag-ui/adk`'s `ADKAgent`, which exposes a typed `getCapabilities()`
 *      that fetches the agent's `/capabilities` endpoint and validates the
 *      response with Zod. Reference implementation:
 *        integrations/adk-middleware/typescript/src/index.ts
 *      Once this class adds equivalent Langroid-specific behavior, making it
 *      publishable requires BOTH removing the `"private": true` / `"//"` keys
 *      from package.json AND enrolling it in the release pipeline — removing
 *      the keys alone will NOT publish it. To enroll: add a TypeScript scope
 *      (e.g. `integration-langroid-ts`, mirroring sibling `integration-*-ts`
 *      scopes) to scripts/release/release.config.json AND add `@ag-ui/langroid`
 *      to nx.json `release.projects`. These two lists must stay in sync or
 *      scripts/release/verify-nx-release-allowlist.sh fails.
 *
 *   2) DELETE THIS TS PACKAGE — accept a Python-only integration shape.
 *      Precedent: some AG-UI integrations are Python-only — e.g. `agent-spec`
 *      ships a Python adapter (`ag-ui-agent-spec`) and no TS package at all.
 *      If Langroid follows that shape, remove this entire TS package
 *      (integrations/langroid/typescript) and rely on the Python integration
 *      (`ag_ui_langroid`) alone.
 */

import { HttpAgent } from "@ag-ui/client";

export class LangroidHttpAgent extends HttpAgent {}

