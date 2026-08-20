import {
  BaseEvent,
  AGUIEvent,
  EventSchemas,
  EventType,
  Message,
  RunFinishedOutcome,
} from "@ag-ui/core";
import * as protoEvents from "./generated/events";
import * as protoPatch from "./generated/patch";

/**
 * These converters run against values that have crossed a wire boundary, so
 * they accept `unknown` and narrow once rather than trusting a static type.
 */
type LooseRecord = Record<string, unknown>;

const asRecord = (value: unknown): LooseRecord | undefined =>
  value && typeof value === "object" ? (value as LooseRecord) : undefined;

const toProtoSource = (source: unknown): unknown => {
  const rec = asRecord(source);
  if (!rec) {
    return undefined;
  }

  if (rec.type === "data") {
    return {
      data: {
        value: rec.value,
        mimeType: rec.mimeType,
      },
    };
  }

  if (rec.type === "url") {
    return {
      url: {
        value: rec.value,
        mimeType: rec.mimeType,
      },
    };
  }

  return undefined;
};

const toProtoContentPart = (part: unknown): unknown => {
  const rec = asRecord(part);
  if (!rec) {
    return undefined;
  }

  switch (rec.type) {
    case "text":
      return {
        text: {
          text: rec.text,
        },
      };
    case "image":
      return {
        image: {
          source: toProtoSource(rec.source),
          metadata: rec.metadata,
        },
      };
    case "audio":
      return {
        audio: {
          source: toProtoSource(rec.source),
          metadata: rec.metadata,
        },
      };
    case "video":
      return {
        video: {
          source: toProtoSource(rec.source),
          metadata: rec.metadata,
        },
      };
    case "document":
      return {
        document: {
          source: toProtoSource(rec.source),
          metadata: rec.metadata,
        },
      };
    case "binary": {
      const source = rec.data
        ? { data: { value: rec.data, mimeType: rec.mimeType } }
        : rec.url
          ? { url: { value: rec.url, mimeType: rec.mimeType } }
          : rec.id
            ? { url: { value: rec.id, mimeType: rec.mimeType } }
            : undefined;

      if (!source) {
        return undefined;
      }

      return {
        document: {
          source,
          metadata: {
            legacyBinary: true,
            filename: rec.filename,
            id: rec.id,
          },
        },
      };
    }
    default:
      return undefined;
  }
};

const fromProtoSource = (source: unknown): unknown => {
  const rec = asRecord(source);
  if (!rec) {
    return undefined;
  }

  if (rec.data) {
    const data = rec.data as LooseRecord;
    return {
      type: "data",
      value: data.value,
      mimeType: data.mimeType,
    };
  }

  if (rec.url) {
    const url = rec.url as LooseRecord;
    return {
      type: "url",
      value: url.value,
      mimeType: url.mimeType,
    };
  }

  return undefined;
};

const fromProtoContentPart = (part: unknown): unknown => {
  const rec = asRecord(part);
  if (!rec) {
    return undefined;
  }

  if (rec.text) {
    const text = rec.text as LooseRecord;
    return {
      type: "text",
      text: text.text,
    };
  }

  if (rec.image) {
    const image = rec.image as LooseRecord;
    return {
      type: "image",
      source: fromProtoSource(image.source),
      metadata: image.metadata,
    };
  }

  if (rec.audio) {
    const audio = rec.audio as LooseRecord;
    return {
      type: "audio",
      source: fromProtoSource(audio.source),
      metadata: audio.metadata,
    };
  }

  if (rec.video) {
    const video = rec.video as LooseRecord;
    return {
      type: "video",
      source: fromProtoSource(video.source),
      metadata: video.metadata,
    };
  }

  if (rec.document) {
    const document = rec.document as LooseRecord;
    return {
      type: "document",
      source: fromProtoSource(document.source),
      metadata: document.metadata,
    };
  }

  return undefined;
};

function toCamelCase(str: string): string {
  return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Encodes an event message to a protocol buffer binary format.
 */
/**
 * Narrows metadata to the object the wire format declares, or nothing.
 *
 * On the validated path the schema has already guaranteed this. On the fallback
 * path below the event is unvalidated, and the generated `Struct.wrap` would
 * quietly mangle anything else — an array becomes `{"0": …}`, a string becomes
 * per-character keys, a number becomes `{}`. Dropping the value is the honest
 * outcome for a shim whose contract is to warn and encode best-effort; the
 * caller already gets a loud warning naming the validation failure.
 *
 * This deliberately differs from the .NET encoder, which throws on non-object
 * metadata. .NET has no compatibility fallback to keep usable.
 */
const normalizeMetadata = (metadata: unknown): LooseRecord | undefined =>
  typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as LooseRecord)
    : undefined;

export function encode(event: BaseEvent): Uint8Array {
  /**
   * In previous versions of AG-UI, we didn't really validate the events
   * against a schema. With stronger types for events and Zod schemas, we
   * can now validate.
   *
   * However, I don't want to break compatibility with existing clients
   * even if they are encoding invalid events. This surfaces a warning
   * to them in those situations.
   *
   * @author mikeryandev
   */
  let validatedEvent: AGUIEvent | BaseEvent;
  try {
    validatedEvent = EventSchemas.parse(event) as AGUIEvent;
  } catch (err) {
    console.warn(
      "[ag-ui][proto.encode] Malformed devent detected, falling back to unvalidated event",
      err,
      event,
    );
    validatedEvent = event;
  }
  const oneofField = toCamelCase(validatedEvent.type);
  const { type, timestamp, rawEvent, metadata, ...rest } = validatedEvent as AGUIEvent as LooseRecord;

  // since protobuf does not support optional arrays, we need to ensure that the toolCalls array is always present
  if (type === EventType.MESSAGES_SNAPSHOT && Array.isArray(rest.messages)) {
    rest.messages = (rest.messages as Message[]).map((message) => {
      const untypedMessage = message as LooseRecord;
      const normalizedMessage: LooseRecord = { ...untypedMessage, contentParts: [] };

      // Same normalisation as the base event below: these messages are
      // unvalidated on the fallback path, so a null or non-object metadata would
      // otherwise reach `Struct.wrap` and throw or be silently mangled.
      normalizedMessage.metadata = normalizeMetadata(untypedMessage.metadata);

      // Tool calls carry metadata of their own, and reach the same Struct.wrap.
      if (Array.isArray(untypedMessage.toolCalls)) {
        normalizedMessage.toolCalls = untypedMessage.toolCalls.map((toolCall: unknown) => ({
          ...(toolCall as LooseRecord),
          metadata: normalizeMetadata(asRecord(toolCall)?.metadata),
        }));
      }

      if (Array.isArray(untypedMessage.content)) {
        const contentParts = untypedMessage.content
          .map((part: unknown) => toProtoContentPart(part))
          .filter((part: unknown) => part !== undefined);

        normalizedMessage.contentParts = contentParts;
        normalizedMessage.content = undefined;
      }

      if (untypedMessage.toolCalls === undefined) {
        normalizedMessage.toolCalls = [];
      }

      return normalizedMessage;
    });
  }

  // RunFinishedEvent: flatten the nested `outcome` discriminated union into the
  // proto's `outcome` (string) and `interrupts` (repeated) fields. The wire
  // shape stays stable; the TS layer just exposes a richer object.
  if (type === EventType.RUN_FINISHED) {
    const outcome = rest.outcome as RunFinishedOutcome | undefined;
    if (outcome === undefined) {
      rest.outcome = "";
      rest.interrupts = [];
    } else if (outcome.type === "interrupt") {
      rest.outcome = "interrupt";
      rest.interrupts = outcome.interrupts;
    } else {
      rest.outcome = "success";
      rest.interrupts = [];
    }
  }

  // Terminal events carry an optional `usage` array. protobuf has no optional
  // repeated field, so normalize to `[]` when absent — otherwise ts-proto's
  // `for (const v of message.usage)` iterates `undefined` and throws. Empty
  // arrays are collapsed back to "no usage" on decode.
  if (type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR) {
    rest.usage = Array.isArray(rest.usage) ? rest.usage : [];
  }

  // custom mapping for json patch operations
  if (type === EventType.STATE_DELTA && Array.isArray(rest.delta)) {
    rest.delta = (rest.delta as LooseRecord[]).map((operation) => ({
      ...operation,
      // Cast, not coercion: `String(op)` would turn malformed values such as
      // `["add"]` into a valid enum member, where this previously threw.
      op: protoPatch.JsonPatchOperationType[
        (operation.op as string).toUpperCase() as keyof typeof protoPatch.JsonPatchOperationType
      ],
    }));
  }

  const eventMessage = {
    [oneofField]: {
      baseEvent: {
        type: protoEvents.EventType[event.type as keyof typeof protoEvents.EventType],
        timestamp,
        rawEvent,
        metadata: normalizeMetadata(metadata),
      },
      ...rest,
    },
  };
  return protoEvents.Event.encode(eventMessage).finish();
}

/**
 * Decodes a protocol buffer binary format to an event message.
 * The format includes a 4-byte length prefix followed by the message.
 */
export function decode(data: Uint8Array): BaseEvent {
  const event = protoEvents.Event.decode(data);
  const decoded = Object.values(event).find((value) => value !== undefined);
  if (!decoded) {
    throw new Error("Invalid event");
  }
  decoded.type = protoEvents.EventType[decoded.baseEvent.type];
  decoded.timestamp = decoded.baseEvent.timestamp;
  decoded.rawEvent = decoded.baseEvent.rawEvent;
  // Struct decodes an absent object to undefined, so an event that carried no
  // metadata stays without the key rather than gaining an empty one.
  if (decoded.baseEvent.metadata !== undefined) {
    decoded.metadata = decoded.baseEvent.metadata;
  }
  delete decoded.baseEvent;

  // we want tool calls to be optional, so we need to remove them if they are empty
  if (decoded.type === EventType.MESSAGES_SNAPSHOT) {
    for (const message of (decoded as LooseRecord).messages as Message[]) {
      const untypedMessage = message as LooseRecord;

      if (untypedMessage.role === "user" && Array.isArray(untypedMessage.contentParts)) {
        const contentParts = untypedMessage.contentParts
          .map((part: unknown) => fromProtoContentPart(part))
          .filter((part: unknown) => part !== undefined);

        if (contentParts.length > 0) {
          untypedMessage.content = contentParts;
        }
      }

      if (Array.isArray(untypedMessage.contentParts) && untypedMessage.contentParts.length === 0) {
        untypedMessage.contentParts = undefined;
      }

      if ((untypedMessage.toolCalls as { length?: number } | undefined)?.length === 0) {
        untypedMessage.toolCalls = undefined;
      }
    }
  }

  // RunFinishedEvent: rebuild the nested `outcome` discriminated union from the
  // flat proto fields. Empty/missing `outcome` decodes to `undefined` (legacy
  // event); "success" decodes to `{ type: "success" }`; "interrupt" decodes to
  // `{ type: "interrupt", interrupts }`.
  if (decoded.type === EventType.RUN_FINISHED) {
    const runFinished = decoded as LooseRecord;
    const wireOutcome: string | undefined =
      typeof runFinished.outcome === "string" && runFinished.outcome !== ""
        ? runFinished.outcome
        : undefined;
    const wireInterrupts: unknown[] = Array.isArray(runFinished.interrupts)
      ? runFinished.interrupts
      : [];

    delete runFinished.interrupts;

    if (wireOutcome === "interrupt") {
      runFinished.outcome = { type: "interrupt", interrupts: wireInterrupts };
    } else if (wireOutcome === "success") {
      runFinished.outcome = { type: "success" };
    } else {
      delete runFinished.outcome;
    }
  }

  // Terminal events: an empty decoded `usage` array means the producer sent no
  // usage — collapse it back to an omitted field so legacy events round-trip
  // cleanly and consumers can rely on `usage === undefined` for "not reported".
  if (decoded.type === EventType.RUN_FINISHED || decoded.type === EventType.RUN_ERROR) {
    if (Array.isArray(decoded.usage) && decoded.usage.length === 0) {
      delete decoded.usage;
    }
  }

  // custom mapping for json patch operations
  if (decoded.type === EventType.STATE_DELTA) {
    for (const operation of (decoded as LooseRecord).delta as LooseRecord[]) {
      operation.op = protoPatch.JsonPatchOperationType[
        operation.op as protoPatch.JsonPatchOperationType
      ].toLowerCase();
      Object.keys(operation).forEach((key) => {
        if (operation[key] === undefined) {
          delete operation[key];
        }
      });
    }
  }

  Object.keys(decoded).forEach((key) => {
    if (decoded[key] === undefined) {
      delete decoded[key];
    }
  });

  return EventSchemas.parse(decoded);
}
