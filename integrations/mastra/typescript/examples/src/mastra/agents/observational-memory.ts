import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";

// An agent with Mastra Observational Memory (OM) enabled. OM is the developer's
// own opt-in: background Observer/Reflector agents read the growing
// conversation, compress older turns into a dense observation log, and activate
// those into the context window. Mastra streams that background work on
// `fullStream` as `data-om-*` chunks; the AG-UI Mastra bridge maps them to
// ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events (activityType
// "mastra-observational-memory") when the bridge's `observationalMemory` toggle
// is on (see getRemoteAgents({ observationalMemory }) in the dojo).
//
// The thresholds are deliberately LOW so the demo triggers observation within a
// few turns instead of needing tens of thousands of tokens. A production agent
// would use much larger windows.
export const observationalMemoryAgent = new Agent({
  id: "observational_memory",
  name: "Observational Memory",
  instructions: `
    You are a friendly assistant with long-term observational memory.

    Just chat naturally with the user. As the conversation grows, your memory
    system observes it in the background and compresses older turns into durable
    observations — you do not need to do anything special for that to happen.
    Keep your replies short and conversational.
  `,
  model: "openai/gpt-4.1-mini",
  memory: new Memory({
    storage: new LibSQLStore({
      id: "observational-memory-memory",
      url: "file:../mastra.db", // path is relative to the .mastra/output directory
    }),
    options: {
      observationalMemory: {
        // Same provider as the main model so a single key drives the demo.
        model: "openai/gpt-4.1-mini",
        scope: "thread",
        observation: {
          // Async buffering: the Observer runs in the background and emits
          // data-om-buffering-* chunks ON the run stream. The trigger is
          // UNOBSERVED message tokens (user + assistant), so the demo/e2e drive
          // a few sizable messages to cross `messageTokens` deterministically.
          // These are the smallest values that reliably trigger buffering;
          // going much lower silently no-ops.
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
