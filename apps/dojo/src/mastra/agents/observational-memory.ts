import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { getStorage } from "../storage";

// An agent with Mastra Observational Memory (OM) enabled. OM is the developer's
// own opt-in: the Observer/Reflector agents run out of band, read the growing
// conversation, compress it into observations, and activate those into the
// context window. Mastra streams that background work on `fullStream` as
// `data-om-*` chunks; the AG-UI Mastra bridge maps them to ACTIVITY_SNAPSHOT /
// ACTIVITY_DELTA events (activityType "mastra-observational-memory") when the
// bridge's `observationalMemory` toggle is on (see src/agents.ts).
//
// The thresholds below are deliberately LOW so the demo triggers observation /
// buffering / activation within a few short turns instead of needing tens of
// thousands of tokens. A production agent would use much larger windows.
export const observationalMemoryAgent = new Agent({
  id: "observational_memory",
  name: "observational_memory",
  instructions: `
    You are a friendly assistant with long-term observational memory.

    Just chat naturally with the user. As the conversation grows, your memory
    system observes it in the background and compresses older turns into
    durable observations — you do not need to do anything special for that to
    happen. Keep your replies short and conversational.
  `,
  model: "openai/gpt-4.1-mini",
  memory: new Memory({
    storage: getStorage(),
    options: {
      observationalMemory: {
        // Use the same provider as the main model so a single key drives the
        // whole demo. OM's default is google/gemini-2.5-flash.
        model: "openai/gpt-4.1-mini",
        scope: "thread",
        observation: {
          // Low threshold so the Observer fires within a turn or two. The
          // trigger is UNOBSERVED message tokens (user + assistant), so what
          // reliably crosses it is message SIZE, not the number of turns — a
          // sizable user message pushes past `messageTokens` regardless of how
          // terse the model's replies are.
          // Async buffering: the Observer runs in the background and emits
          // data-om-buffering-* chunks ON the run stream (verified against
          // @mastra/memory 1.21.2 — the synchronous path does NOT surface on
          // the stream in this version). These values are the smallest that
          // reliably trigger buffering in practice; going much lower silently
          // no-ops (the tokenizer batches below a floor). The trigger is
          // UNOBSERVED message tokens (user + assistant), so the demo/e2e drive
          // a few sizable messages to cross `messageTokens` deterministically
          // regardless of how terse the model's replies are.
          messageTokens: 600,
          bufferTokens: 300,
        },
        reflection: {
          observationTokens: 1_500,
        },
      },
    },
  }),
});
