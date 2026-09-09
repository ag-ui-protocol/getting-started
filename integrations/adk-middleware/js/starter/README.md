# AG-UI + Google ADK JavaScript starter

This Next.js application runs a native Google ADK JavaScript `Runner` inside
the CopilotKit runtime through `@ag-ui/adk-js`.

## Run it

```bash
cp .env.example .env.local
# Add your Google AI Studio key to .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The server route in
`app/api/copilotkit/route.ts` is the complete ADK-to-AG-UI integration; the
browser page contains only the CopilotKit client.

The starter is server-only where it imports `@ag-ui/adk-js` and `@google/adk`.
Do not import either package from a browser component. It pins the `@google/adk`
2.x release it was tested with; `@ag-ui/adk-js` requires 2.x.
