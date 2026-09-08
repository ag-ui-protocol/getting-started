/**
 * Real-SDK test harness.
 *
 * Most adapter tests drive a hand-rolled `Agent` stub (see `scriptedAgent` in
 * `helpers.ts`), which is fine for asserting the adapter's own event mapping
 * but cannot catch a break in the contract between the adapter and Strands.
 * Interrupts are the case where that matters most: the `Interrupt` class is
 * exported from `@strands-agents/sdk` as a type only, so a fabricated
 * `{ id, name, reason }` object cast to `Interrupt` compiles and passes even
 * if the real SDK stops producing that shape.
 *
 * This harness supplies the one piece a test cannot use for real: the model.
 * `ScriptedModel` replays scripted turns so no provider is called, which lets
 * a test build a genuine `Agent` and have the SDK construct the interrupts,
 * tool calls and results itself.
 */

import {
  Model,
  Message,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StopReason,
  type StreamOptions,
} from "@strands-agents/sdk";

/** One model turn: either a tool call or a plain text reply. */
export type ScriptedTurn =
  | { kind: "toolUse"; name: string; toolUseId: string; input: unknown }
  | { kind: "text"; text: string };

/**
 * A `Model` that replays scripted turns instead of calling a provider. Each
 * `stream()` call consumes the next turn, so a script of
 * `[toolUse, text]` drives one tool round-trip followed by a final answer.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  private _config: BaseModelConfig;
  private _turns: ScriptedTurn[];
  private readonly _scriptedTurns: number;
  /**
   * One entry per turn the agent actually consumed, in order.
   *
   * `stream()` is an async generator, so nothing is recorded until the caller
   * starts draining it, and a turn that overruns the script throws instead of
   * being recorded. The array of messages is snapshotted so later turns do not
   * rewrite earlier entries; the Message objects inside are the agent's own.
   */
  readonly calls: Message[][] = [];

  /** The `StreamOptions` each `stream()` call was given, index-aligned with `calls`. */
  readonly callOptions: (StreamOptions | undefined)[] = [];

  constructor(turns: ScriptedTurn[], config: BaseModelConfig = {}) {
    super();
    this._turns = [...turns];
    this._scriptedTurns = turns.length;
    this._config = { modelId: "scripted-model", ...config };
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this._config = { ...this._config, ...modelConfig };
  }

  getConfig(): BaseModelConfig {
    return this._config;
  }

  async *stream(
    messages: Message[],
    _options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    const turn = this._turns.shift();
    if (turn === undefined) {
      // Inventing a turn here would hide the regression that matters most:
      // the agent looping more times than the test scripted.
      throw new Error(
        `ScriptedModel: the agent asked for turn ${this.calls.length + 1} but ` +
          `only ${this._scriptedTurns} were scripted.`,
      );
    }
    this.calls.push([...messages]);
    this.callOptions.push(_options);

    yield new ModelMessageStartEvent({
      type: "modelMessageStartEvent",
      role: "assistant",
    });

    let stopReason: StopReason;
    if (turn.kind === "toolUse") {
      yield new ModelContentBlockStartEvent({
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: turn.name,
          toolUseId: turn.toolUseId,
        },
      });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "toolUseInputDelta",
          input: JSON.stringify(turn.input),
        },
      });
      stopReason = "toolUse";
    } else {
      yield new ModelContentBlockStartEvent({
        type: "modelContentBlockStartEvent",
      });
      yield new ModelContentBlockDeltaEvent({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: turn.text },
      });
      stopReason = "endTurn";
    }

    yield new ModelContentBlockStopEvent({
      type: "modelContentBlockStopEvent",
    });
    yield new ModelMessageStopEvent({
      type: "modelMessageStopEvent",
      stopReason,
    });
    // Real providers report usage; emitting it keeps anything that reads
    // metadata on the same path it takes in production.
    yield new ModelMetadataEvent({
      type: "modelMetadataEvent",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  }
}
