import assert from "node:assert/strict";
import test from "node:test";

import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  A2UIMiddleware,
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
} from "@ag-ui/a2ui-middleware";
import { Observable, firstValueFrom, toArray } from "rxjs";

import { dynamicSchemaCatalog } from "./a2ui-catalog";
import { DOJO_A2UI_MIDDLEWARE_CONFIG } from "./a2ui-config";

class CaptureAgent extends AbstractAgent {
  readonly runCalls: RunAgentInput[] = [];

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

test("Dojo A2UI middleware forwards the rendered dynamic catalog", async () => {
  const downstream = new CaptureAgent();
  const middleware = new A2UIMiddleware(DOJO_A2UI_MIDDLEWARE_CONFIG);

  await firstValueFrom(
    middleware
      .run(
        {
          threadId: "test-thread",
          runId: "test-run",
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
          messages: [],
        },
        downstream,
      )
      .pipe(toArray()),
  );

  assert.equal(downstream.runCalls.length, 1);
  const forwarded = downstream.runCalls[0];
  const schemaContext = forwarded.context.find(
    ({ description }) => description === A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  );
  assert.ok(
    schemaContext && typeof schemaContext.value === "string",
    "dynamic catalog schema must reach downstream agent context",
  );

  const schema = JSON.parse(schemaContext.value) as {
    catalogId: string;
    components: Record<
      string,
      { allOf?: Array<{ properties?: Record<string, unknown> }> }
    >;
  };
  assert.equal(schema.catalogId, dynamicSchemaCatalog.id);
  assert.deepEqual(Object.keys(schema.components), [
    ...dynamicSchemaCatalog.components.keys(),
  ]);

  const hotelProperties = schema.components.HotelCard.allOf?.find(
    ({ properties }) => properties,
  )?.properties;
  assert.ok(hotelProperties);
  assert.ok("pricePerNight" in hotelProperties);
  const rating = hotelProperties.rating as {
    anyOf?: Array<{ type?: string }>;
  };
  assert.ok(rating.anyOf?.some(({ type }) => type === "number"));
});
