# Java ADK example server

Executable Java 21 server for the ADK middleware's currently supported Dojo features.
It exposes AG-UI over SSE at:

- `POST /chat`
- `POST /adk-human-in-loop-agent`
- `POST /adk-agentic-generative-ui`

The HITL and generative-UI examples use request-defined frontend tools. The HITL app is
ADK-resumable; the generative-UI agent is instructed to drive the client's `create_plan`
and `update_plan_step` tools. This deliberately does not claim Python-only backend-event
tool parity.

Build the middleware snapshot, then run the example:

```bash
cd ..
mvn install
cd examples
mvn exec:java
```

The server binds `HOST` (default `0.0.0.0`) and `PORT` (default `8000`). Google ADK reads
`GOOGLE_API_KEY` or Application Default Credentials from the environment.
