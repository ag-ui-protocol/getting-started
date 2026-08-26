/**
 * Predictive State Updates example for AWS Strands (TypeScript).
 *
 * Mirrors `python/examples/server/api/predictive_state_updates.py`.
 *
 * `write_document` is declared on the frontend (the dojo page registers it via
 * `useHumanInTheLoop`), so the adapter auto-registers it as a proxy tool when
 * `RunAgentInput.tools` arrives. No backend tool here.
 *
 * The demo is the `predictState` mapping below. Before the first argument delta
 * reaches the browser, the adapter emits a `PredictState` custom event saying
 * that the tool's `document` argument feeds the `document` state key. The
 * frontend then paints the document editor from the partial JSON while the model
 * is still streaming it, instead of waiting for the completed tool call.
 *
 * `stateFromArgs` closes the loop with an authoritative `StateSnapshot`
 * carrying the finished document, emitted before `TOOL_CALL_END` so the
 * editor's optimistic text is replaced by server-confirmed state rather than
 * left as a prediction.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";
import { demoPort, runIfMain } from "../run-if-main";

const SYSTEM_PROMPT = `You are a helpful assistant for writing documents.

To write or edit the document, you MUST use the \`write_document\` tool.
You MUST pass the full updated document, even when changing only a few words.
When making edits, keep them minimal: do not rewrite every word.
Format the document with markdown, but never use italic or strike-through
formatting, which is reserved for showing the user a diff.
Keep stories SHORT.

After calling the tool, do NOT repeat the document as a message. Just briefly
summarize the changes you made, 2 sentences max.`;

const config: StrandsAgentConfig = {
  stateContextBuilder: (input, prompt) => {
    const state = (input.state ?? {}) as Record<string, unknown>;
    const document = state.document;
    if (typeof document !== "string" || document.length === 0) return prompt;
    return `This is the current state of the document:\n----\n${document}\n----\n\nUser request: ${prompt}`;
  },
  toolBehaviors: {
    write_document: {
      predictState: [
        {
          stateKey: "document",
          tool: "write_document",
          toolArgument: "document",
        },
      ],
      // Mirrors the Python demo, including its tolerance for a string
      // `toolInput`: the adapter hands over a parsed object today, but the two
      // demos are meant to read the same, and a bare string would otherwise
      // publish no state at all while looking like it worked.
      // The adapter calls this once the tool call is complete, so the arguments
      // are final and every give-up path is a genuine surprise. Each one says
      // so, because returning null silently leaves the browser showing its own
      // prediction with nothing authoritative behind it, which looks exactly
      // like success.
      stateFromArgs: async (ctx) => {
        let input: unknown = ctx.toolInput;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            console.warn(
              "write_document arguments were not valid JSON; no authoritative document state published",
            );
            return null;
          }
        }
        // `typeof [] === "object"`, so arrays need their own check to be
        // reported honestly rather than described as objects.
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input)
        ) {
          const kind = Array.isArray(input) ? "an array" : `${typeof input}`;
          console.warn(
            `write_document arguments were ${kind}, not an object; no authoritative document state published`,
          );
          return null;
        }
        const document = (input as { document?: unknown }).document;
        if (typeof document !== "string") {
          console.warn(
            `write_document produced no string \`document\` argument (got ${typeof document}); the editor keeps its prediction with nothing to confirm it`,
          );
          return null;
        }
        return { document };
      },
    },
  },
};

export async function createPredictiveStateUpdatesAgent(): Promise<StrandsAgent> {
  return new StrandsAgent({
    agent: new Agent({
      // Chat Completions API: the Responses adapter buffers tool-call argument
      // deltas, which would leave the editor blank until the call completes and
      // defeat the point of the predict-state mapping.
      model: await createModel({ openaiApi: "chat" }),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
    }),
    name: "predictive_state_updates",
    description:
      "AWS Strands document editor that streams tool arguments into shared state",
    config,
  });
}

runIfMain(import.meta.url, async () => {
  const app = await createStrandsApp(
    await createPredictiveStateUpdatesAgent(),
    { path: "/" },
  );
  const port = demoPort();
  app.listen(port, () => {
    console.log(
      `predictive-state-updates demo listening on http://localhost:${port}`,
    );
  });
});
