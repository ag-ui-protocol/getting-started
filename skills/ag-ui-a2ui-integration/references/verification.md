# Verification

Use this checklist before calling an AG-UI + A2UI integration complete.

## Static Checks

- Install dependencies with the app's existing package manager.
- Run the app's typecheck, lint, and unit tests when available.
- Run the AG-UI package or integration tests touched by the change.
- Confirm no invented package names, CLI flags, or import paths were added.

## Runtime Checks

- Start the AG-UI backend or runtime route.
- Start the frontend app.
- Trigger a user prompt that should produce A2UI.
- Confirm the stream begins with a valid AG-UI run and ends with
  `RUN_FINISHED` or `RUN_ERROR`.
- For dynamic schema, confirm `generate_a2ui` leads to streamed
  `render_a2ui` tool-call args and `ACTIVITY_SNAPSHOT` events with
  `activityType: "a2ui-surface"`.
- For fixed schema, confirm the backend tool result contains an
  `a2ui_operations` envelope.
- Confirm an A2UI surface renders, not just a text explanation.
- Confirm a user interaction in the rendered surface flows back to the agent.
- Check the browser console and backend logs for schema, hydration, stream, or
  action bridge errors.

## Common Failure Modes

| Symptom                               | Likely cause                                                         | Fix                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No A2UI surface appears               | A2UI is enabled only on the client or only on the runtime            | Enable renderer/catalog plus `A2UIMiddleware` or runtime A2UI config                                                                                                    |
| Agent describes UI in prose           | Agent lacks `generate_a2ui` or fixed-schema backend tools            | Use the framework A2UI tool factory/auto-injection or return `a2ui_operations`                                                                                          |
| Custom component never renders        | Catalog id or component keys differ between server and client        | Register the catalog and align `defaultCatalogId`, `catalogId`, and names                                                                                               |
| Dynamic surface appears only at end   | Nested `render_a2ui` args are not streaming to the AG-UI wire        | Use the adapter's streaming A2UI tool path, not a non-streaming sub-agent invoke                                                                                        |
| Action clicks do nothing              | The action bridge is not reaching `forwardedProps.a2uiAction`        | Verify the client action is forwarded and middleware emits `log_a2ui_event`                                                                                             |
| Skeletons duplicate or flicker        | Middleware is applied twice or catalog/tool names are misconfigured  | Use either runtime-level or per-agent middleware for each agent, not both                                                                                               |
| `Catalog not found` in the renderer   | Model or server stamped a catalog id the client did not register     | Forward the catalog to the provider (`a2ui={{ catalog }}`, CopilotKit >= 1.61.2) so its id is auto-derived; otherwise set `defaultCatalogId` to the renderer catalog id |
| Invalid component tree keeps retrying | Components fail toolkit validation against the inline/client catalog | Fix required props, child refs, root layout, and component names                                                                                                        |

A runtime smoke test should show the AG-UI stream in logs or devtools, an
`a2ui-surface` activity or `a2ui_operations` result, a rendered A2UI surface in
the page, and one user interaction returning through AG-UI.
