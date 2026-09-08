import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { EventTraceAssertionError } from "./event-trace-update";

const require = createRequire(import.meta.url);
const CleanReporter = require("../clean-reporter.cjs") as new () => {
  onTestEnd(
    playwrightTest: { parent: { title: string }; title: string },
    result: {
      status: string;
      error: { message: string; stack?: string };
      errors?: Array<{ message?: string; stack?: string } | string>;
      stdout: string[];
    },
  ): void;
};

test("the clean reporter prints the complete semantic event trace mismatch", () => {
  const reporter = new CleanReporter();
  const mismatch = new EventTraceAssertionError({
    expected: [
      {
        type: "STATE_SNAPSHOT",
        snapshot: { messages: [{ content: "Mango" }] },
      },
    ],
    actual: [
      {
        type: "STATE_SNAPSHOT",
        snapshot: { messages: [{ content: "Apple" }] },
      },
    ],
  });
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  };

  try {
    reporter.onTestEnd(
      { parent: { title: "LangGraph Tests" }, title: "retains memory" },
      {
        status: "failed",
        error: mismatch,
        stdout: [],
      },
    );
  } finally {
    console.log = originalLog;
  }

  const rendered = output.join("\n");
  assert.match(rendered, /first difference: events\[0\]/);
  assert.match(rendered, /expected: "Mango"/);
  assert.match(rendered, /actual: "Apple"/);
  assert.doesNotMatch(rendered, /Likely cause: AI service down/);
});

test("the clean reporter uses Playwright's serialized stack for the complete mismatch", () => {
  const reporter = new CleanReporter();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  };

  try {
    reporter.onTestEnd(
      { parent: { title: "LangGraph Tests" }, title: "retains memory" },
      {
        status: "failed",
        error: {
          message:
            "EventTraceAssertionError: Event trace mismatch: trace.ts#journey",
          stack: [
            "EventTraceAssertionError: Event trace mismatch: trace.ts#journey",
            "  events: expected=2, actual=1",
            "  event 1: expected RUN_FINISHED, actual <end>",
            "  Full traces are attached to the Playwright test result.",
            "    at assertEventTraceMatches (event-trace-update.ts:256:11)",
          ].join("\n"),
        },
        stdout: [],
      },
    );
  } finally {
    console.log = originalLog;
  }

  const rendered = output.join("\n");
  assert.match(rendered, /events: expected=2, actual=1/);
  assert.match(rendered, /event 1: expected RUN_FINISHED, actual <end>/);
  assert.doesNotMatch(rendered, /at assertEventTraceMatches/);
});
