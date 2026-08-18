/**
 * LLMock server for ADK middleware Python integration tests.
 *
 * Starts an LLMock instance that intercepts Gemini API calls made by the
 * google-genai Python client (via GOOGLE_GEMINI_BASE_URL).
 *
 * Usage:
 *   node server.mjs --fixtures-dir <path> [--port PORT]
 *
 * The server prints "LLMOCK_READY <url>" to stdout when ready.
 */

import { LLMock } from "@copilotkit/aimock";
import * as path from "node:path";

// Parse CLI arguments
const args = process.argv.slice(2);
const fixturesIdx = args.indexOf("--fixtures-dir");
const portIdx = args.indexOf("--port");

const FIXTURES_DIR = fixturesIdx !== -1 ? path.resolve(args[fixturesIdx + 1]) : null;
const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 0;

if (!FIXTURES_DIR) {
  console.error("Usage: node server.mjs --fixtures-dir <path> [--port PORT]");
  process.exit(1);
}

const mock = new LLMock({ port, latency: 5 });

// Load JSON fixtures
mock.loadFixtureDir(FIXTURES_DIR);

// ---------------------------------------------------------------------------
// Tool-call fixtures: when a request includes a specific tool and the last
// message is from the user (not a tool result), return a functionCall for
// that tool.  This covers HITL, LRO, and skip_summarization test patterns.
// ---------------------------------------------------------------------------

/** Return true if `req.tools` contains a tool with the given name. */
const hasTool = (req, name) =>
  req.tools?.some((t) => t.function.name === name) ?? false;

/** Return true if the last message in the conversation is from the user. */
const lastIsUser = (req) => {
  const last = req.messages[req.messages.length - 1];
  return last?.role === "user";
};

/** Extract the text of the last user message. */
const lastUserText = (req) => {
  const msg = req.messages.filter((m) => m.role === "user").pop();
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  return "";
};

// Helper: add a fixture that fires when the request contains `toolName`
// and the last message is a user message.  Returns a functionCall with
// the given arguments.
//
// The `id` is supplied deliberately. aimock's Gemini serializer used to fall back
// to a generated id (`id: tc.id || generateToolCallId()`); that fallback was
// dropped before 1.23.1, which emitted no id at all, and 1.24.1 restored emission
// but only for an id the fixture supplies. Without an id, ADK's
// `populate_client_function_call_id()` mints a fresh UUID per SSE event, so the
// partial and final events disagree — the exact failure `_extract_lro_id_remap`
// and test_lro_sse_id_remap.py exist to work around, and which the remap only
// covers for LRO calls. Pinning restores a stable id and is deterministic,
// which is better than the old random fallback.
const addToolCallFixture = (toolName, args) => {
  // Counter, not a constant id: a stable id would collide when the same tool is
  // invoked twice in one session, and several things key state by tool-call id —
  // this middleware's own `_processed_message_ids` (session_manager.py) drops a
  // ToolMessage whose id it has already seen, and `pending_tool_calls` collapses
  // duplicates. The suffix counts how many times this server has served the
  // tool, so ids are unique per invocation and stable for a given request
  // sequence (not globally fixed). Loosely mirrors aimock's own
  // `call_gemini_${name}_${i}`, though that index is positional within a single
  // request rather than a session counter.
  let calls = 0;
  mock.addFixture({
    match: {
      predicate: (req) => hasTool(req, toolName) && lastIsUser(req),
    },
    response: () => ({
      toolCalls: [
        {
          name: toolName,
          arguments: JSON.stringify(args),
          id: `call_${toolName}_${++calls}`,
        },
      ],
    }),
  });
};

// HITL / LRO tools
addToolCallFixture("get_greeting", { name: "Alice" });
addToolCallFixture("approve_action", { action: "task X" });
addToolCallFixture("get_approval", { action: "proceed with the task" });
addToolCallFixture("get_confirmation", {});
addToolCallFixture("check_status", {});
addToolCallFixture("plan_task", { steps: ["Step 1", "Step 2"] });
addToolCallFixture("plan_steps", {
  steps: [
    { description: "Buy groceries", status: "enabled" },
    { description: "Cook dinner", status: "enabled" },
    { description: "Serve food", status: "enabled" },
  ],
});
addToolCallFixture("approve_plan", {
  plan: { topic: "Paris trip", sections: ["Day 1", "Day 2"] },
});
addToolCallFixture("verify_sources", {
  sources: [{ title: "Source 1", url: "https://example.com" }],
});

// skip_summarization backend tools
addToolCallFixture("get_weather_with_skip_summarization", {
  location: "San Francisco",
});
addToolCallFixture("get_temperature", { location: "Boston" });
addToolCallFixture("weather_skip_sum", { city: "Seattle" });
addToolCallFixture("tool_with_skip", { query: "skip query" });
addToolCallFixture("tool_without_skip", { query: "normal query" });
addToolCallFixture("slow_skip_tool", { data: "test_value" });

// ---------------------------------------------------------------------------
// Thinking / reasoning fixtures: return responses with a `reasoning` field
// so LLMock emits Gemini `thought: true` parts before content.
// ---------------------------------------------------------------------------

/** Extract system message text from a request. */
const sysText = (req) => {
  const sys = req.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
};

// Thinking agent — system prompt contains "careful reasoning assistant"
mock.addFixture({
  match: {
    predicate: (req) =>
      sysText(req).includes("careful reasoning assistant") && lastIsUser(req),
  },
  response: {
    reasoning:
      "Let me think through this step by step. I need to read the problem carefully. " +
      "The key phrase is 'all but 9 run away' which means 9 remain. " +
      "This is a classic trick question that tests reading comprehension.",
    content: "The farmer has 9 sheep left. The phrase 'all but 9 run away' means 9 sheep remain.",
  },
});

// ---------------------------------------------------------------------------
// Multimodal fixtures: match on user message text to return responses that
// satisfy the assertion checks (color names, document topics, etc.).
// ---------------------------------------------------------------------------

mock.addFixture({
  match: {
    predicate: (req) => {
      const text = lastUserText(req);
      return text.includes("Describe this image") && !text.includes("two");
    },
  },
  response: { content: "The image shows a solid red square." },
});

mock.addFixture({
  match: {
    predicate: (req) => lastUserText(req).includes("Describe each of these two images"),
  },
  response: {
    content:
      "The first image is a solid red square. The second image is a solid blue square.",
  },
});

mock.addFixture({
  match: {
    predicate: (req) => lastUserText(req).includes("What is this document about"),
  },
  response: {
    content:
      "This document describes IP over Avian Carriers with Quality of Service, " +
      "a humorous network protocol using carrier pigeons.",
  },
});

mock.addFixture({
  match: {
    predicate: (req) => lastUserText(req).includes("horizontal colour stripes"),
  },
  response: { content: "The stripes from top to bottom are: blue, white, red." },
});

// ---------------------------------------------------------------------------
// Tool result catch-all: when the last message is a tool result,
// return a generic text acknowledgment (same pattern as Dojo aimock-setup.ts)
// ---------------------------------------------------------------------------
mock.prependFixture({
  match: {
    predicate: (req) => {
      const last = req.messages[req.messages.length - 1];
      return last?.role === "tool";
    },
  },
  response: { content: "Done! I've completed that for you." },
});

// Universal catch-all: matches any request not handled above.
//
// The diagnostic lives in the RESPONSE FACTORY, not in the predicate. Since
// aimock 1.34.0 the matcher evaluates every candidate's `match.predicate`
// before selecting a winner, so a side effect inside a predicate fires on
// every request. That matters more here than in the dojo: conftest.py starts
// this server with stderr=PIPE and never drains it, and Node's writes to a
// pipe are synchronous on Linux — a per-request log would fill the 64 KiB
// buffer and block the event loop mid-run. A response factory runs only when
// this fixture is actually served, i.e. only on a genuine miss.
mock.addFixture({
  // endpoint: "chat" is load-bearing. A *function* response skips aimock's
  // per-endpoint response-shape gate (router.js), so an unscoped catch-all
  // becomes eligible for image/speech/transcription/video requests it could
  // never match before, turning their honest 404 into a mis-attributed 500.
  match: {
    endpoint: "chat",
    predicate: () => true,
  },
  response: (req) => {
    const lastUser = req.messages.filter((m) => m.role === "user").pop();
    const userText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("")
          : "(no user msg)";
    console.error(
      `[llmock CATCH-ALL] model=${req.model} lastUser="${String(userText).slice(0, 80)}" msgs=${req.messages.length}`,
    );
    return { content: "I understand. How can I help you with that?" };
  },
});

const url = await mock.start();

// Signal readiness to the parent process (pytest conftest reads this)
console.log(`LLMOCK_READY ${url}`);

// Keep alive until killed
process.on("SIGTERM", async () => {
  await mock.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await mock.stop();
  process.exit(0);
});
