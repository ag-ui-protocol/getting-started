/**
 * Citations reach the client attached to the assistant message they annotate,
 * under the `citations` key of that message's metadata.
 *
 * Two things make this more than a passthrough. Citations arrive interleaved
 * with the text they support, so what a client holds mid-stream has to be a
 * whole prefix rather than a fragment. And a `MESSAGES_SNAPSHOT` replaces the
 * message a client assembled, so the snapshot's own copy has to carry them or
 * they vanish the moment one arrives.
 *
 * One suite below drives the real SDK rather than handing the adapter a
 * literal, so the delta shape asserted there is the one Strands produces. The
 * rest script the adapter's input directly, which is what lets them cover
 * shapes a real Bedrock stream cannot be made to emit on demand.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Agent as StrandsAgentCore,
  type AgentStreamEvent,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { EventType, type AssistantMessage, type BaseEvent } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import {
  CITATIONS_METADATA_KEY,
  CitationAccumulator,
  type AguiCitation,
} from "../citations";
import {
  collect,
  minimalRunInput,
  ScriptedModel,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

/** A Bedrock citation as the TypeScript SDK hands it to the adapter. */
function citationDelta(
  overrides: Record<string, unknown> = {},
  content: { text: string }[] = [],
): AgentStreamEvent {
  return {
    type: "modelContentBlockDeltaEvent",
    delta: {
      type: "citationsDelta",
      citations: [
        {
          title: "quarterly-report.pdf",
          source: "",
          sourceContent: [{ text: "revenue grew 12%" }],
          location: {
            type: "documentChar",
            documentIndex: 0,
            start: 10,
            end: 26,
          },
          ...overrides,
        },
      ],
      content,
    },
  } as unknown as AgentStreamEvent;
}

function citationsOn(event: BaseEvent | undefined): AguiCitation[] | undefined {
  const metadata = event?.metadata as
    | Record<string, AguiCitation[]>
    | undefined;
  return metadata?.[CITATIONS_METADATA_KEY];
}

function eventsOfType(events: BaseEvent[], type: EventType): BaseEvent[] {
  return events.filter((e) => e.type === type);
}

function lastSnapshotAssistant(
  events: BaseEvent[],
): AssistantMessage | undefined {
  const snapshots = eventsOfType(events, EventType.MESSAGES_SNAPSHOT);
  const last = snapshots[snapshots.length - 1] as
    | { messages?: AssistantMessage[] }
    | undefined;
  return last?.messages?.filter((m) => m.role === "assistant").pop();
}

describe("citations on the assistant message", () => {
  it("publishes each citation on the next text delta, as a growing whole list", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew 12%."),
      citationDelta({ title: "first.pdf" }),
      stream.textDelta(" Margins held."),
      citationDelta({ title: "second.pdf" }),
      stream.textDelta(" Costs fell."),
    ]);

    const contents = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_CONTENT,
    );

    // Nothing before the first citation, then one, then both. Each publish is a
    // complete list because metadata merging replaces a key rather than
    // appending to it.
    expect(contents.map((e) => citationsOn(e)?.map((c) => c.title))).toEqual([
      undefined,
      ["first.pdf"],
      ["first.pdf", "second.pdf"],
    ]);
  });

  it("does not re-send an unchanged list on every later delta", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("a"),
      citationDelta(),
      stream.textDelta("b"),
      stream.textDelta("c"),
      stream.textDelta("d"),
    ]);

    const carrying = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_CONTENT,
    ).filter((e) => citationsOn(e) !== undefined);

    expect(carrying).toHaveLength(1);
  });

  it("records how much of the message had streamed when each citation arrived", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta({ title: "first.pdf" }),
      stream.textDelta(" Margins held."),
      citationDelta({ title: "second.pdf" }),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];

    expect(citationsOn(end)?.map((c) => c.textOffset)).toEqual([
      "Revenue grew.".length,
      "Revenue grew. Margins held.".length,
    ]);
  });

  it("carries the complete list on TEXT_MESSAGE_END", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta({ title: "first.pdf" }),
      citationDelta({ title: "second.pdf" }),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];

    expect(citationsOn(end)?.map((c) => c.title)).toEqual([
      "first.pdf",
      "second.pdf",
    ]);
  });

  it("reaches the client when no text follows the citation at all", async () => {
    // The mid-stream publish rides the next text delta, so a citation that
    // arrives last has only the closing events to travel on.
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta(),
    ]);
    const events = await collect(agent);

    const carriedMidStream = eventsOfType(
      events,
      EventType.TEXT_MESSAGE_CONTENT,
    ).some((e) => citationsOn(e) !== undefined);
    expect(carriedMidStream).toBe(false);

    const end = eventsOfType(events, EventType.TEXT_MESSAGE_END)[0];
    expect(citationsOn(end)).toHaveLength(1);
  });

  it("keeps them on the snapshot message, which replaces what the client assembled", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta({ title: "quarterly-report.pdf" }),
    ]);

    const message = lastSnapshotAssistant(await collect(agent));

    expect(message?.content).toBe("Revenue grew.");
    expect(
      (message?.metadata as Record<string, AguiCitation[]> | undefined)?.[
        CITATIONS_METADATA_KEY
      ]?.map((c) => c.title),
    ).toEqual(["quarterly-report.pdf"]);
  });

  it("attaches nothing at all when the model cites nothing", async () => {
    const events = await collect(
      scriptedStrandsAgent([stream.textDelta("Revenue grew.")]),
    );

    expect(eventsOfType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(1);
    for (const event of events) {
      expect(citationsOn(event)).toBeUndefined();
    }
    const message = lastSnapshotAssistant(events);
    expect(message).toBeDefined();
    expect(message!.metadata).toBeUndefined();
  });

  it("does not carry one message's citations into the next", async () => {
    // A tool call closes the assistant turn and rotates message_id. The
    // citations of the closed message must not reappear on the new one.
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta({ title: "first.pdf" }),
      stream.toolUseStart("tool-1", "lookup"),
      stream.toolUseDelta("{}"),
      stream.blockStop(),
      stream.textDelta("Done."),
    ]);
    const events = await collect(agent);

    const ends = eventsOfType(events, EventType.TEXT_MESSAGE_END);
    expect(ends.length).toBeGreaterThan(1);
    expect(citationsOn(ends[0])?.map((c) => c.title)).toEqual(["first.pdf"]);
    expect(citationsOn(ends[ends.length - 1])).toBeUndefined();
  });
});

describe("the citation shape on the wire", () => {
  it("omits the empty strings and lists this SDK coalesces, so both bridges agree", async () => {
    // The TypeScript SDK fills a missing `source` or `title` with `""` while
    // the Python one leaves the key out. Keeping the empties would make the two
    // adapters disagree about a citation that is identical on the provider side.
    const agent = scriptedStrandsAgent([
      stream.textDelta("x"),
      citationDelta({ title: "", source: "", sourceContent: [] }),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];

    expect(citationsOn(end)).toEqual([
      {
        location: {
          type: "documentChar",
          documentIndex: 0,
          start: 10,
          end: 26,
        },
        textOffset: 1,
      },
    ]);
  });

  it("keeps the generated span when the provider reports one", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew 12%."),
      citationDelta({}, [{ text: "Revenue grew 12%." }]),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];

    expect(citationsOn(end)?.[0].content).toEqual([
      { text: "Revenue grew 12%." },
    ]);
  });

  it("unwraps a location a custom provider forwards in Bedrock's wrapped form", async () => {
    // This SDK flattens the location itself, but a custom `Model` can forward
    // Bedrock's `{ documentChar: { ... } }` untouched — which is also the shape
    // the Python adapter receives. Both must produce the discriminated form.
    const agent = scriptedStrandsAgent([
      stream.textDelta("x"),
      citationDelta({
        location: { documentPage: { documentIndex: 2, start: 4, end: 5 } },
      }),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];

    expect(citationsOn(end)?.[0].location).toEqual({
      type: "documentPage",
      documentIndex: 2,
      start: 4,
      end: 5,
    });
  });

  it("splits a delta carrying several citations into several entries", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "citationsDelta",
          citations: [{ title: "a.pdf" }, { title: "b.pdf" }],
          content: [{ text: "Revenue grew." }],
        },
      } as unknown as AgentStreamEvent,
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];
    const cited = citationsOn(end);

    expect(cited?.map((c) => c.title)).toEqual(["a.pdf", "b.pdf"]);
    // `content` is a property of the delta, not of each citation, so both get
    // the same generated span and the same offset.
    expect(cited?.map((c) => c.content)).toEqual([
      [{ text: "Revenue grew." }],
      [{ text: "Revenue grew." }],
    ]);
    expect(cited?.map((c) => c.textOffset)).toEqual([13, 13]);
  });
});

describe("citations in chunk mode", () => {
  it("survives the collapse to TEXT_MESSAGE_CHUNK", async () => {
    const agent = scriptedStrandsAgent(
      [
        stream.textDelta("Revenue grew."),
        citationDelta({ title: "first.pdf" }),
        stream.textDelta(" Margins held."),
      ],
      { config: { emitChunkEvents: true } },
    );

    const chunks = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_CHUNK,
    );
    const carrying = chunks
      .map((e) => citationsOn(e)?.map((c) => c.title))
      .filter(Boolean);

    // Twice: once mid-stream on the delta that follows the citation, and once
    // on the closing metadata-only chunk. Both carry the complete list, and
    // metadata merging replaces a key's value rather than appending, so the
    // repeat is a no-op for the reducer rather than a duplicate citation.
    expect(carrying).toEqual([["first.pdf"], ["first.pdf"]]);
  });
});

describe("against the real Strands SDK", () => {
  it("translates the citationsDelta the SDK genuinely emits", async () => {
    // Bedrock interleaves citation deltas with the text deltas of the same
    // content block, which is what `modelTurn` cannot express: it has no
    // citation variant. Scripting the block by hand keeps the SDK's own
    // aggregation in the loop.
    const turn = [
      { type: "modelMessageStartEvent", role: "assistant" },
      { type: "modelContentBlockStartEvent" },
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "Revenue grew 12%." },
      },
      {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "citationsDelta",
          citations: [
            {
              title: "quarterly-report.pdf",
              source: "",
              sourceContent: [{ text: "revenue grew 12%" }],
              location: {
                type: "documentChar",
                documentIndex: 0,
                start: 10,
                end: 26,
              },
            },
          ],
          content: [],
        },
      },
      { type: "modelContentBlockStopEvent" },
      { type: "modelMessageStopEvent", stopReason: "endTurn" },
    ] as ModelStreamEvent[];

    const model = new ScriptedModel([turn]);
    const agent = new StrandsAgent({
      agent: new StrandsAgentCore({ model, tools: [] as never }),
      name: "test",
    });

    const events = await collect(agent);
    const end = eventsOfType(events, EventType.TEXT_MESSAGE_END)[0];

    expect(citationsOn(end)).toEqual([
      {
        title: "quarterly-report.pdf",
        sourceContent: [{ text: "revenue grew 12%" }],
        location: {
          type: "documentChar",
          documentIndex: 0,
          start: 10,
          end: 26,
        },
        textOffset: "Revenue grew 12%.".length,
      },
    ]);
  });
});

describe("citations on the multi-agent orchestrator path", () => {
  // The orchestrator generator is a separate translation path with no message
  // snapshot behind it, so a node's citations reach the client only through
  // that node's own message events.
  function fakeOrchestrator(events: unknown[]) {
    return {
      id: "test-graph",
      // No `model` field, which is how the adapter picks the orchestrator path.
      async *stream(_input: string) {
        for (const e of events) yield e;
      },
    };
  }

  function nodeDelta(nodeId: string, delta: unknown) {
    return {
      type: "nodeStreamUpdateEvent",
      nodeId,
      inner: {
        source: "agent",
        event: { type: "modelContentBlockDeltaEvent", delta },
      },
    };
  }

  it("attaches a node's citations to that node's message", async () => {
    const orchestrator = fakeOrchestrator([
      { type: "beforeNodeCallEvent", nodeId: "researcher" },
      nodeDelta("researcher", { type: "textDelta", text: "Revenue grew." }),
      nodeDelta("researcher", {
        type: "citationsDelta",
        citations: [{ title: "first.pdf" }],
        content: [],
      }),
      { type: "afterNodeCallEvent", nodeId: "researcher", nodeType: "agent" },
      { type: "beforeNodeCallEvent", nodeId: "writer" },
      nodeDelta("writer", { type: "textDelta", text: "Final answer." }),
      { type: "afterNodeCallEvent", nodeId: "writer", nodeType: "agent" },
    ]);

    const agent = new StrandsAgent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: orchestrator as any,
      name: "t",
    });
    const ends = eventsOfType(await collect(agent), EventType.TEXT_MESSAGE_END);

    expect(ends).toHaveLength(2);
    expect(citationsOn(ends[0])).toEqual([
      { title: "first.pdf", textOffset: "Revenue grew.".length },
    ]);
    // The next node starts with none of the previous node's citations.
    expect(citationsOn(ends[1])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------

describe("regressions found in review", () => {
  it("restarts the offset per message when snapshots are off", async () => {
    // The offset used to be measured from `accumulatedText`, which is reset
    // only inside the `emitMessagesSnapshot` guard, so with snapshots off the
    // counter kept climbing and every message after the first carried
    // run-wide offsets.
    const agent = scriptedStrandsAgent(
      [
        stream.textDelta("Revenue grew."),
        citationDelta({ title: "first.pdf" }),
        stream.toolUseStart("tool-1", "lookup"),
        stream.toolUseDelta("{}"),
        stream.blockStop(),
        stream.textDelta("Margins held up well."),
        citationDelta({ title: "second.pdf" }),
      ],
      { config: { emitMessagesSnapshot: false } },
    );

    const ends = eventsOfType(await collect(agent), EventType.TEXT_MESSAGE_END);

    // Deliberately different lengths: with equal ones the assertion cannot
    // tell a per-message offset from a run-wide one.
    expect(ends.length).toBeGreaterThan(1);
    expect(citationsOn(ends[0])?.map((c) => c.textOffset)).toEqual([
      "Revenue grew.".length,
    ]);
    // Not "Revenue grew.".length + "Margins held up well.".length.
    expect(
      citationsOn(ends[ends.length - 1])?.map((c) => c.textOffset),
    ).toEqual(["Margins held up well.".length]);
  });

  it("keeps a previous turn's citations through the seeded snapshot", async () => {
    // A MESSAGES_SNAPSHOT replaces the message a client assembled, and the seed
    // is rebuilt from RunAgentInput.messages field by field. Dropping metadata
    // there wiped turn one's citations the moment turn two started.
    const agent = scriptedStrandsAgent([stream.textDelta("Margins held.")]);

    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          {
            id: "a1",
            role: "assistant",
            content: "Revenue grew.",
            metadata: {
              [CITATIONS_METADATA_KEY]: [
                { title: "first.pdf", textOffset: 13 },
              ],
            },
          },
          { id: "u2", role: "user", content: "and margins?" },
        ],
      }),
    );

    const snapshots = eventsOfType(events, EventType.MESSAGES_SNAPSHOT);
    expect(snapshots.length).toBeGreaterThan(0);
    const echoed = (
      snapshots[snapshots.length - 1] as unknown as {
        messages: AssistantMessage[];
      }
    ).messages.find((m) => m.id === "a1");
    expect(echoed).toBeDefined();
    expect(
      (echoed!.metadata as Record<string, AguiCitation[]> | undefined)?.[
        CITATIONS_METADATA_KEY
      ]?.map((c) => c.title),
    ).toEqual(["first.pdf"]);
  });

  it("drops a citation that never had a message, loudly, instead of carrying it", async () => {
    const warn = vi.fn();
    const agent = scriptedStrandsAgent(
      [
        citationDelta({ title: "orphan.pdf" }),
        stream.toolUseStart("tool-1", "lookup"),
        stream.toolUseDelta("{}"),
        stream.blockStop(),
        stream.textDelta("Margins held."),
      ],
      { config: { logger: { debug: vi.fn(), warn, error: vi.fn() } } },
    );

    const events = await collect(agent);

    const ends = eventsOfType(events, EventType.TEXT_MESSAGE_END);
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) {
      expect(citationsOn(end)).toBeUndefined();
    }
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("no open assistant message"),
      ),
    ).toBe(true);
  });

  it("drops an unserializable citation rather than breaking the stream", async () => {
    // A value that will not encode aborts the whole SSE stream, costing the
    // client its TEXT_MESSAGE_END, snapshots and RUN_FINISHED.
    const cyclic: Record<string, unknown> = { type: "documentChar" };
    cyclic.self = cyclic;
    const warn = vi.fn();

    const agent = scriptedStrandsAgent(
      [
        stream.textDelta("Revenue grew."),
        citationDelta({ title: "bad.pdf", location: cyclic }),
        citationDelta({ title: "good.pdf" }),
      ],
      { config: { logger: { debug: vi.fn(), warn, error: vi.fn() } } },
    );

    const events = await collect(agent);
    const end = eventsOfType(events, EventType.TEXT_MESSAGE_END)[0];

    expect(citationsOn(end)?.map((c) => c.title)).toEqual(["good.pdf"]);
    expect(() => JSON.stringify(events)).not.toThrow();
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("unserializable citation"),
      ),
    ).toBe(true);
  });

  it("drops a non-finite number instead of silently nulling it", async () => {
    // JSON.stringify would turn NaN into null; the Python sibling raises on it.
    const agent = scriptedStrandsAgent([
      stream.textDelta("x"),
      citationDelta({
        title: "nan.pdf",
        location: {
          type: "documentChar",
          documentIndex: 0,
          start: NaN,
          end: 1,
        },
      }),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];
    expect(citationsOn(end)).toBeUndefined();
  });

  it("drops a citation that names no source at all", async () => {
    // An entry holding only textOffset renders as a marker pointing at nothing.
    const agent = scriptedStrandsAgent([
      stream.textDelta("x"),
      {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "citationsDelta",
          citations: [
            { title: "", source: "", sourceContent: [], location: {} },
          ],
          content: [],
        },
      } as unknown as AgentStreamEvent,
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];
    expect(citationsOn(end)).toBeUndefined();
  });

  it("carries a non-empty source and a web location to the wire", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta({
        title: "quarterly-report.pdf",
        source: "https://example.test/q4",
        sourceContent: [{ text: "revenue grew 12%" }],
        location: {
          type: "web",
          url: "https://example.test/q4",
          domain: "example.test",
        },
      }),
    ]);

    const end = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_END,
    )[0];

    expect(citationsOn(end)).toEqual([
      {
        title: "quarterly-report.pdf",
        source: "https://example.test/q4",
        sourceContent: [{ text: "revenue grew 12%" }],
        location: {
          type: "web",
          url: "https://example.test/q4",
          domain: "example.test",
        },
        textOffset: "Revenue grew.".length,
      },
    ]);
  });

  it("does not let a later publish mutate an earlier one", () => {
    const accumulator = new CitationAccumulator();
    accumulator.advance("Revenue grew.");
    accumulator.add({
      type: "citationsDelta",
      citations: [{ title: "first.pdf", sourceContent: [{ text: "a" }] }],
      content: [],
    });

    const first = accumulator.pending()!;
    first[CITATIONS_METADATA_KEY][0].sourceContent![0].text = "mutated";

    expect(
      accumulator.take()![CITATIONS_METADATA_KEY][0].sourceContent![0].text,
    ).toBe("a");
  });

  it("delivers a trailing citation in chunk mode on a metadata-only chunk", async () => {
    // Chunk mode drops TEXT_MESSAGE_END, which is the only event a citation
    // arriving after the last text delta rides. Its metadata is re-emitted as
    // a continuation chunk instead, which the client transform turns into a
    // zero-delta content event so the reducer still sees it.
    const agent = scriptedStrandsAgent(
      [stream.textDelta("Revenue grew."), citationDelta({ title: "last.pdf" })],
      { config: { emitChunkEvents: true } },
    );

    const events = await collect(agent);

    expect(eventsOfType(events, EventType.TEXT_MESSAGE_END)).toEqual([]);

    const chunks = eventsOfType(events, EventType.TEXT_MESSAGE_CHUNK);
    const carrying = chunks.filter((e) => citationsOn(e) !== undefined);
    expect(carrying).toHaveLength(1);
    expect(citationsOn(carrying[0])?.map((c) => c.title)).toEqual(["last.pdf"]);

    // Carried by a continuation chunk, not by re-opening the message.
    const last = carrying[0] as { delta?: string; role?: string };
    expect(last.delta).toBeUndefined();
    expect(last.role).toBeUndefined();

    // The snapshot still carries it too, for a client that takes the snapshot
    // as authoritative.
    const message = lastSnapshotAssistant(events);
    expect(message).toBeDefined();
    expect(
      (message!.metadata as Record<string, AguiCitation[]> | undefined)?.[
        CITATIONS_METADATA_KEY
      ]?.map((c) => c.title),
    ).toEqual(["last.pdf"]);
  });
});

// ---------------------------------------------------------------------------
// The shape contract the two adapters share
// ---------------------------------------------------------------------------
//
// Each assertion below has a counterpart in the Python adapter's
// `test_citations.py`, under the same heading. They are the executable form of
// the README's claim that both bridges produce equal objects for the same
// Bedrock response, so a change to one that is not made to the other shows up
// as a diff between two test files rather than as a support ticket.

// A four-byte emoji: two UTF-16 code units, one Python character. The offset is
// an index a browser will slice with, so UTF-16 is the unit both sides count.
const EMOJI_TEXT = "Revenue grew \u{1F4C8} fast.";
const EMOJI_UTF16_LEN = 21;

/** Drive one citation through the accumulator and return what it publishes. */
function normalizedVia(
  citation: unknown,
  content: { text: string }[] = [],
  log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
): { entry: AguiCitation | undefined; warn: ReturnType<typeof vi.fn> } {
  const accumulator = new CitationAccumulator(log);
  accumulator.add({ type: "citationsDelta", citations: [citation], content });
  const metadata = accumulator.take();
  return { entry: metadata?.[CITATIONS_METADATA_KEY]?.[0], warn: log.warn };
}

describe("the shape contract the two adapters share", () => {
  it("counts the offset in UTF-16 code units", () => {
    const accumulator = new CitationAccumulator();
    accumulator.advance(EMOJI_TEXT);
    accumulator.add({
      type: "citationsDelta",
      citations: [{ title: "x.pdf" }],
      content: [],
    });

    expect(EMOJI_TEXT.length).toBe(EMOJI_UTF16_LEN);
    expect(accumulator.take()![CITATIONS_METADATA_KEY][0].textOffset).toBe(
      EMOJI_UTF16_LEN,
    );
  });

  it("renames a search-result location to the shared discriminator", () => {
    // Bedrock wraps it as `searchResultLocation`; this SDK emits `searchResult`.
    const { entry } = normalizedVia({
      title: "x.pdf",
      location: {
        searchResultLocation: { searchResultIndex: 2, start: 1, end: 4 },
      },
    });
    expect(entry?.location).toEqual({
      type: "searchResult",
      searchResultIndex: 2,
      start: 1,
      end: 4,
    });
  });

  it("keeps the names of the other location kinds", () => {
    for (const kind of [
      "documentChar",
      "documentPage",
      "documentChunk",
      "web",
    ]) {
      const { entry } = normalizedVia({
        title: "x.pdf",
        location: { [kind]: { start: 1 } },
      });
      expect((entry?.location as { type: string }).type).toBe(kind);
    }
  });

  it("treats an empty or unusable location as no location", () => {
    for (const location of [
      { documentChar: {} },
      {},
      null,
      "documentChar",
      false,
      0,
    ]) {
      const { entry } = normalizedVia({ title: "x.pdf", location });
      expect(entry?.location).toBeUndefined();
    }
  });

  it("drops location fields the provider left empty", () => {
    // The SDK omits a falsy `domain` rather than emitting it.
    const { entry } = normalizedVia({
      title: "x.pdf",
      location: { web: { url: "https://example.test", domain: "" } },
    });
    expect(entry?.location).toEqual({
      type: "web",
      url: "https://example.test",
    });
  });

  it("passes an already flattened location through", () => {
    const flat = {
      type: "documentChar",
      documentIndex: 0,
      start: 1,
      end: 2,
    };
    const { entry } = normalizedVia({ title: "x.pdf", location: flat });
    expect(entry?.location).toEqual(flat);
  });

  it("still drops a citation rescued only by an empty location", () => {
    const { entry } = normalizedVia({
      title: "",
      location: { documentChar: {} },
    });
    expect(entry).toBeUndefined();
  });

  it("does not let the generated span alone stand in for a source", () => {
    // `content` comes from the delta, not the citation. A marker carrying only
    // the text it annotates points a reader at nothing.
    const { entry } = normalizedVia({}, [{ text: "Revenue grew." }]);
    expect(entry).toBeUndefined();
  });

  it("drops a citation that is not an object, with a warning", () => {
    const { entry, warn } = normalizedVia(["not", "a", "citation"]);
    expect(entry).toBeUndefined();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("not an object")),
    ).toBe(true);
  });
});

describe("malformed citation deltas", () => {
  it("claims a delta whose citations field is not an array, and says so", () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const accumulator = new CitationAccumulator(log);

    expect(
      accumulator.add({
        type: "citationsDelta",
        citations: "nope",
        content: [],
      }),
    ).toBe(true);
    expect(accumulator.take()).toBeUndefined();
    expect(
      log.warn.mock.calls.some((c) => String(c[0]).includes("not an array")),
    ).toBe(true);
  });

  it("claims an empty delta rather than handing it to the RAW fallback", async () => {
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "citationsDelta", citations: [], content: [] },
      } as unknown as AgentStreamEvent,
    ]);
    const events = await collect(agent);

    expect(events.filter((e) => e.type === EventType.RAW)).toEqual([]);
    expect(eventsOfType(events, EventType.TEXT_MESSAGE_END)).toHaveLength(1);
  });
});

describe("more regressions found in review", () => {
  it("keeps the snapshot copy independent of the event on the wire", async () => {
    // The retained message is re-emitted in every later snapshot of the run.
    const agent = scriptedStrandsAgent([
      stream.textDelta("Revenue grew."),
      citationDelta({ title: "quarterly-report.pdf" }),
    ]);
    const events = await collect(agent);

    const end = eventsOfType(events, EventType.TEXT_MESSAGE_END)[0];
    const message = lastSnapshotAssistant(events);
    const wire = citationsOn(end)!;
    const retained = (message!.metadata as Record<string, AguiCitation[]>)[
      CITATIONS_METADATA_KEY
    ];

    expect(wire).toEqual(retained);
    expect(wire).not.toBe(retained);
    wire[0].title = "mutated";
    expect(retained[0].title).toBe("quarterly-report.pdf");
  });

  it("drops an orchestrator node's citations when it produced no message", async () => {
    const orchestrator = {
      id: "test-graph",
      async *stream(_input: string) {
        yield { type: "beforeNodeCallEvent", nodeId: "citer" };
        yield {
          type: "nodeStreamUpdateEvent",
          nodeId: "citer",
          inner: {
            source: "agent",
            event: {
              type: "modelContentBlockDeltaEvent",
              delta: {
                type: "citationsDelta",
                citations: [{ title: "orphan.pdf" }],
                content: [],
              },
            },
          },
        };
        yield {
          type: "afterNodeCallEvent",
          nodeId: "citer",
          nodeType: "agent",
        };
        yield { type: "beforeNodeCallEvent", nodeId: "writer" };
        yield {
          type: "nodeStreamUpdateEvent",
          nodeId: "writer",
          inner: {
            source: "agent",
            event: {
              type: "modelContentBlockDeltaEvent",
              delta: { type: "textDelta", text: "Revenue grew." },
            },
          },
        };
        yield {
          type: "afterNodeCallEvent",
          nodeId: "writer",
          nodeType: "agent",
        };
      },
    };

    const warn = vi.fn();
    const agent = new StrandsAgent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: orchestrator as any,
      name: "t",
      config: { logger: { debug: vi.fn(), warn, error: vi.fn() } },
    });
    const ends = eventsOfType(await collect(agent), EventType.TEXT_MESSAGE_END);

    expect(ends).toHaveLength(1);
    expect(citationsOn(ends[0])).toBeUndefined();
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("no open assistant message"),
      ),
    ).toBe(true);
  });
});

describe("hostile citation input", () => {
  it("does not let an inherited key become a location kind", () => {
    // A plain-object alias table resolves `constructor` and `toString` through
    // the prototype chain, so the kind would be replaced by a function and the
    // whole location dropped. The wrapper key must survive as the kind.
    for (const key of ["constructor", "toString", "valueOf"]) {
      const { entry } = normalizedVia({
        title: "x.pdf",
        location: { [key]: { start: 1, end: 2 } },
      });
      expect((entry?.location as { type?: unknown } | undefined)?.type).toBe(
        key,
      );
    }
  });

  it("drops a location whose discriminator is not a string", () => {
    const { entry } = normalizedVia({
      title: "x.pdf",
      location: { type: 42, start: 1 },
    });
    expect(entry?.location).toBeUndefined();
  });
});

describe("chunked multi-agent mode", () => {
  /**
   * The configuration the capability document claimed and did not deliver:
   * chunk events on, driving an orchestrator, whose path emits no
   * MESSAGES_SNAPSHOT at all. A citation arriving after the node's last text
   * delta had nothing left to ride once the END was dropped.
   */
  function citingOrchestrator() {
    return {
      id: "test-graph",
      async *stream(_input: string) {
        yield { type: "beforeNodeCallEvent", nodeId: "researcher" };
        yield {
          type: "nodeStreamUpdateEvent",
          nodeId: "researcher",
          inner: {
            source: "agent",
            event: {
              type: "modelContentBlockDeltaEvent",
              delta: { type: "textDelta", text: "Revenue grew." },
            },
          },
        };
        yield {
          type: "nodeStreamUpdateEvent",
          nodeId: "researcher",
          inner: {
            source: "agent",
            event: {
              type: "modelContentBlockDeltaEvent",
              delta: {
                type: "citationsDelta",
                citations: [{ title: "trailing.pdf" }],
                content: [],
              },
            },
          },
        };
        yield {
          type: "afterNodeCallEvent",
          nodeId: "researcher",
          nodeType: "agent",
        };
      },
    };
  }

  it("delivers a trailing citation with no snapshot to fall back on", async () => {
    const agent = new StrandsAgent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: citingOrchestrator() as any,
      name: "t",
      config: { emitChunkEvents: true },
    });

    const events = await collect(agent);

    // The premise: no END, and no snapshot anywhere on this path.
    expect(eventsOfType(events, EventType.TEXT_MESSAGE_END)).toEqual([]);
    expect(eventsOfType(events, EventType.MESSAGES_SNAPSHOT)).toEqual([]);

    const carrying = eventsOfType(events, EventType.TEXT_MESSAGE_CHUNK).filter(
      (e) => citationsOn(e) !== undefined,
    );
    expect(carrying).toHaveLength(1);
    expect(citationsOn(carrying[0])?.map((c) => c.title)).toEqual([
      "trailing.pdf",
    ]);
    expect(citationsOn(carrying[0])?.[0].textOffset).toBe(
      "Revenue grew.".length,
    );
  });

  it("keeps the chunk on the message it annotates", async () => {
    const agent = new StrandsAgent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: citingOrchestrator() as any,
      name: "t",
      config: { emitChunkEvents: true },
    });

    const chunks = eventsOfType(
      await collect(agent),
      EventType.TEXT_MESSAGE_CHUNK,
    ) as { messageId?: string; metadata?: unknown }[];

    const opener = chunks.find((c) => c.metadata === undefined);
    const carrying = chunks.find((c) => c.metadata !== undefined);
    expect(opener?.messageId).toBeDefined();
    expect(carrying?.messageId).toBe(opener?.messageId);
  });
});

describe("an untagged location", () => {
  it("is omitted with a warning, and the citation survives", () => {
    // A provider sending an untagged shape still named a source, so dropping
    // the whole citation would lose more than it protects.
    const { entry, warn } = normalizedVia({
      title: "quarterly-report.pdf",
      location: { documentChar: "0-9" },
    });

    expect(entry?.title).toBe("quarterly-report.pdf");
    expect(entry?.location).toBeUndefined();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("not in tagged form")),
    ).toBe(true);
  });

  it("is not warned about when the provider sent no location at all", () => {
    const { entry, warn } = normalizedVia({ title: "x.pdf" });

    expect(entry?.title).toBe("x.pdf");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("not in tagged form")),
    ).toBe(false);
  });
});
