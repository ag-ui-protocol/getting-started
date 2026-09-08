/**
 * What one cold run costs a deployment in egress, and what it tells a client
 * when an attachment does not make it to the model.
 *
 * A cold run converts the same turns more than once: once to build the
 * construction-time seed, and again to reconcile the replayed history. Both
 * conversions resolve the same attachments, so the number of requests a run
 * makes has to be asserted rather than assumed.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";
import { urlFetchTransport } from "../utils";

/** The fetch policy resolves the host first, so it has to answer publicly. */
function mockPublicDns() {
  return vi
    .spyOn(dns.promises, "lookup")
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
}

function mockPngFetch() {
  return vi.spyOn(urlFetchTransport, "request").mockImplementation(
    async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  );
}

function imageAt(url: string, mimeType?: string) {
  return {
    type: "image",
    source: mimeType
      ? { type: "url", value: url, mimeType }
      : { type: "url", value: url },
  };
}

function customNamed(events: BaseEvent[], name: string): BaseEvent[] {
  return events.filter(
    (e) =>
      e.type === EventType.CUSTOM && (e as { name?: string }).name === name,
  );
}

describe("remote attachments over one cold run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads an attachment once even though the run converts it twice", async () => {
    mockPublicDns();
    const fetchMock = mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "egress-1",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [imageAt("https://example.test/a.png", "image/png")],
          } as never,
          { id: "a1", role: "assistant", content: "seen" } as never,
          { id: "u2", role: "user", content: "and now?" } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads one url once however many turns carry it", async () => {
    mockPublicDns();
    const fetchMock = mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "egress-2",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [imageAt("https://example.test/same.png", "image/png")],
          } as never,
          { id: "a1", role: "assistant", content: "seen" } as never,
          {
            id: "u2",
            role: "user",
            content: [imageAt("https://example.test/same.png", "image/png")],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps separate urls separate", async () => {
    mockPublicDns();
    const fetchMock = mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "egress-3",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [imageAt("https://example.test/one.png", "image/png")],
          } as never,
          { id: "a1", role: "assistant", content: "seen" } as never,
          {
            id: "u2",
            role: "user",
            content: [imageAt("https://example.test/two.png", "image/png")],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not carry one run's downloads into the next on the same thread", async () => {
    mockPublicDns();
    const fetchMock = mockPngFetch();
    const { agent } = realStrandsAgent([
      modelTurn.text("ok"),
      modelTurn.text("ok"),
    ]);
    const messages = [
      {
        id: "u1",
        role: "user",
        content: [imageAt("https://example.test/a.png", "image/png")],
      } as never,
    ];

    // One thread, deliberately. Varying the thread as well lets a cache that
    // outlives its run keep this green: the second run would then miss for the
    // wrong reason.
    for (const runId of ["run-1", "run-2"]) {
      const events: BaseEvent[] = [];
      for await (const e of agent.run(
        minimalRunInput({ threadId: "egress-same-thread", runId, messages }),
      )) {
        events.push(e);
      }
      expectCompletedRun(events, runId);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("attachments that do not reach the model", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not interrupt a seed download on abandonment, and says so", async () => {
    mockPublicDns();
    let sawAbort = false;
    vi.spyOn(urlFetchTransport, "request").mockImplementation(
      (_t, _a, _p, signal) =>
        new Promise((resolve) => {
          const s = signal as AbortSignal;
          if (s.aborted) sawAbort = true;
          else
            s.addEventListener("abort", () => (sawAbort = true), {
              once: true,
            });
          // Settles on its own so the run completes; the point is whether the
          // abort arrived BEFORE it did.
          setTimeout(
            () =>
              resolve(
                new Response(new Uint8Array([1]), {
                  status: 200,
                  headers: { "content-type": "image/png" },
                }),
              ),
            30,
          );
        }) as never,
    );
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const iterator = agent
      .run(
        minimalRunInput({
          threadId: "abandon-1",
          messages: [
            {
              id: "u1",
              role: "user",
              content: [imageAt("https://example.test/slow.png", "image/png")],
            } as never,
            { id: "a1", role: "assistant", content: "seen" } as never,
            { id: "u2", role: "user", content: "and now?" } as never,
          ],
        }),
      )
      [Symbol.asyncIterator]();

    await iterator.next();
    const parked = iterator.next();
    await new Promise((r) => setImmediate(r));
    const returned = iterator.return!(undefined);
    // The abort has NOT arrived, and this test exists to keep that honest. An
    // async generator parked inside an `await` cannot be interrupted, and
    // every media fetch happens inside one, so the endpoint's `return()` on
    // client disconnect queues behind the download rather than cancelling it.
    // The signal does reach the fetch and does cancel it when something aborts
    // mid-flight (see the cancellation case in multimodal-conversion), but
    // nothing reaches it from a disconnect. Closing that needs a cancellation
    // channel that does not go through generator abandonment.
    expect(sawAbort).toBe(false);

    await parked.catch(() => {});
    await returned.catch(() => {});
  });

  it("still resolves an attachment that declares no type", async () => {
    mockPublicDns();
    const fetchMock = mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "untyped-1",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [imageAt("https://example.test/untyped")],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(customNamed(events, "MediaDropped")).toEqual([]);
  });

  it("reports a partial loss on the live turn", async () => {
    mockPublicDns();
    mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "loss-1",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "two images" },
              imageAt("https://example.test/ok.png", "image/png"),
              imageAt("https://example.test/nope.bmp", "image/bmp"),
            ],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    const reported = customNamed(events, "MediaDropped");
    expect(reported).toHaveLength(1);
    expect((reported[0] as unknown as { value: unknown }).value).toEqual({
      dropped: [{ type: "image", reason: "unsupported media type" }],
      // The text block alongside the image is not counted: the question the
      // report answers is how many attachments arrived.
      delivered: 1,
    });
  });

  it("says nothing when every attachment reaches the model", async () => {
    mockPublicDns();
    mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "loss-2",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "one image" },
              imageAt("https://example.test/ok.png", "image/png"),
            ],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(customNamed(events, "MediaDropped")).toEqual([]);
  });

  it("reports only the live turn, not attachments lost from history", async () => {
    mockPublicDns();
    mockPngFetch();
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "loss-history",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "an old turn" },
              imageAt("https://example.test/old.bmp", "image/bmp"),
            ],
          } as never,
          { id: "a1", role: "assistant", content: "seen" } as never,
          { id: "u2", role: "user", content: "and now?" } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    // Deliberate scope. The report answers "what did the turn I just sent
    // lose", so a drop from an earlier turn stays quiet rather than being
    // re-announced on every subsequent run of the thread.
    expect(customNamed(events, "MediaDropped")).toEqual([]);
  });

  it("converts a deprecated binary attachment instead of losing it", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "binary-1",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              {
                type: "binary",
                mimeType: "image/png",
                data: Buffer.from("PNG").toString("base64"),
              },
            ],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    // The gate omitted this type, so the converter's binary branch was
    // unreachable and the attachment was dropped before conversion with no
    // report. It now converts, so nothing is reported lost.
    expectCompletedRun(events);
    expect(customNamed(events, "MediaDropped")).toEqual([]);
  });

  it("fails loudly when a binary-only message cannot be converted", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "binary-2",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              {
                type: "binary",
                mimeType: "image/bmp",
                data: Buffer.from("BMP").toString("base64"),
              },
            ],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    // Previously the gate skipped this message, leaving the prompt as the
    // empty string that flattening a binary-only message produces, and the
    // model was asked nothing at all. Refusing the run is the honest outcome.
    const errors = events.filter((e) => e.type === EventType.RUN_ERROR);
    expect(errors).toHaveLength(1);
    expect((errors[0] as unknown as { code: string }).code).toBe(
      "MEDIA_RESOLUTION_FAILED",
    );
  });

  it("reports what was lost before refusing a turn it cannot send", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "loss-total",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [imageAt("https://example.test/x.bmp", "image/bmp")],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }

    // This is the case where the reasons matter most, and it used to be the
    // one case the client never got them: the refusal returned first.
    const reported = customNamed(events, "MediaDropped");
    expect(reported).toHaveLength(1);
    expect(
      (reported[0] as unknown as { value: { dropped: unknown[] } }).value
        .dropped,
    ).toEqual([{ type: "image", reason: "unsupported media type" }]);
    const errors = events.filter((e) => e.type === EventType.RUN_ERROR);
    expect(errors).toHaveLength(1);
    // Order matters: the account has to arrive before the refusal.
    expect(events.indexOf(reported[0]!)).toBeLessThan(
      events.indexOf(errors[0]!),
    );
  });

  it("says nothing when the turn carried no attachments at all", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        threadId: "loss-3",
        messages: [{ id: "u1", role: "user", content: "plain text" } as never],
      }),
    )) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(customNamed(events, "MediaDropped")).toEqual([]);
  });
});
