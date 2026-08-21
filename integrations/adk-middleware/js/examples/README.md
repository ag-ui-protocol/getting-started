# ADK-JS Dojo examples

These server-side agents are loaded directly by `apps/dojo`; they do not need a
separate HTTP process. Set `GOOGLE_API_KEY`, start the Dojo, and select
**Google ADK (JavaScript)**.

The examples cover:

- streaming chat with a frontend tool;
- backend weather-tool execution and rendering;
- frontend-tool generative UI;
- ADK session-state synchronization; and
- a native `adk_request_input` interrupt/resume round trip.

`ADK_JS_MODEL` defaults to `gemini-2.5-flash`. To test with a local
OpenAI-compatible server such as llama.cpp instead, set:

```sh
ADK_JS_OPENAI_BASE_URL=http://127.0.0.1:8080/v1
ADK_JS_MODEL=gemma-4-26b-a4b-it
```

`ADK_JS_API_KEY` is optional and is only sent when configured. The local
adapter supports text and ADK function-tool loops; ADK live sessions are not
supported by llama.cpp's chat-completions endpoint.

With the local server running, execute the real model/tool/protocol smoke test:

```sh
pnpm nx test:llm @ag-ui/adk-js-examples
```
