# Conformance fixtures

A fixture is one event stream, replayed into a client exactly as a producer
would have sent it, together with the outcome the specification requires of any
client that consumes it. The same files run in two lanes:

| Lane | Where | How the stream arrives |
| --- | --- | --- |
| TypeScript | `sdks/typescript/packages/client/src/conformance/__tests__/streams.test.ts` | aimock serves it over real HTTP as SSE frames into an `HttpAgent` |
| .NET | `sdks/dotnet/tests/AGUI.Client.UnitTests` | the same bytes are served through the real SSE formatter and event converter |

They exist because the rules in the specification were, until now, only ever
tested against the implementation that happened to hold them — which is how the
two clients ended up disagreeing about what to do with something they do not
recognise, with both test suites green.

## Adding a fixture

Write one JSON file in `streams/`. The file name is the fixture name.

```jsonc
{
  "name": "unknown-event-dropped",        // must equal the file name
  "area": "processing",                    // groups the test output
  "description": "one line: what this proves",
  "specPage": "/spec/draft/basic/processing",
  "kill": "the one-line change to the implementation that must make this fail",

  "client": { "maxProtocolVersion": "0.0.57" },   // optional: pins the peer era
  "input": { "messages": [ … ], "tools": [ … ] }, // optional: what the run starts from

  "stream": [ /* raw event objects, sent verbatim */ ],

  "expect": { /* see below */ },
  "expectOverrides": { "dotnet": { "intentional": "why", /* … */ } }
}
```

Then run your lane:

```bash
pnpm -C sdks/typescript/packages/client exec vitest run src/conformance
cd sdks/dotnet && dotnet test -p:SignAssembly=false --nologo
```

### `stream`

Sent verbatim, with no validation on the way out. That is the point: most
fixtures send something no conforming producer ever would — an event from a
future version, a field holding the wrong type, a sequence that breaks the
rules. Write the raw JSON you want on the wire.

Use identifiers prefixed with the fixture name (`"threadId": "t-unknown-event"`)
so a failure in the output names itself.

### `expect`

Every key is optional; state what the rule actually requires and nothing more.

| Key | Asserts |
| --- | --- |
| `outcome` | whether the **client** accepted the stream (`"completed"`) or rejected it (`"failed"`) |
| `errorContains` | substring of the error a client rejection surfaces |
| `runError` | the **run** reported its own failure: `true`, or a substring of the message |
| `warnings` | each string must appear in some warning |
| `noWarnings` | no warning at all was emitted |
| `messageCount` | how many messages the client holds afterwards |
| `messages` | subset-matched against the final messages, in order |
| `state` | subset-matched against the final state |
| `request` | subset-matched against the `RunAgentInput` the client sent |
| `requestAbsentPaths` | dotted paths that must be absent from that input |

`outcome` and `runError` are deliberately separate. A client rejecting a stream
it considers malformed and an agent honestly reporting that its run failed are
different events, and a format that called both "failed" could not tell a
conformance failure from a working error path.

`messages`, `state` and `request` are **subset** matches: arrays must be the
same length, objects are compared only on the keys you name. Assert what the
specification requires — an exact match would fail on incidentals the two
clients differ about for no interesting reason.

`request` is how the input-direction rules are tested at all. Two of the
compatibility shims never touch the event stream: they transform the
`RunAgentInput` on its way out, so the only observable is what the client sent.

### `kill`

Name the single change to the implementation that must make this fixture fail.
It is a required field because a fixture that cannot fail is worse than no
fixture — it reads as coverage while proving nothing. Before you commit one,
make that change locally and watch it go red.

### `expectOverrides`

Where the two clients legitimately differ, the fixture records it rather than
leaving it as a silent inconsistency:

```jsonc
"expectOverrides": {
  "dotnet": {
    "intentional": "the .NET client has no enforcement stage, so nothing is stripped and no warning is emitted; alignment is tracked separately",
    "warnings": []
  }
}
```

The keys an override names replace those keys in `expect` for that lane; every
other key still applies. `intentional` is required — an override without a
stated reason is the thing this suite exists to prevent.

Today the .NET lane carries most of the overrides, because several stages the
TypeScript client has do not exist there yet: no strip-and-warn enforcement, no
chunk expansion, no state store, no activity reducer. Those overrides are the
acceptance suite for aligning it — when a divergence is closed, delete the
override and both lanes assert the same thing.

A lane may also be unable to observe a key at all. The .NET lane cannot check
`state`, because the client keeps none; it skips that key and says so rather
than pretending. An override says a lane *differs*; a skipped key says a lane
*cannot see*. Do not use one to mean the other.

### Asserting that something is *gone*

The matchers can require a key to equal a value; they cannot require a key to
be absent (except in the request, via `requestAbsentPaths`). Where a fixture
needs to prove a removal, use a shape a wrong implementation cannot produce:

- **A dropped state key** — make the replacing snapshot a root-level array
  (`["only-this"]`). No merge can produce that, so a `state = {...old, ...new}`
  regression fails. It doubles as proof that state may be any JSON value.
- **A non-recursive metadata merge** — give a key an array value and change its
  length (`["one","two"]` → `["three"]`). Arrays are length-checked exactly, so
  a deep merge fails.
- **A dropped list element** — assert the whole array. Same length check.

If you find yourself unable to express a removal this way, say so in the
fixture's `description` rather than asserting something weaker that looks
equivalent.

## What does not belong here

- **Producer correctness.** These fixtures test consumers. Whether an
  integration emits good streams is covered by that integration's own suite.
- **Recording.** Nothing here captures a real agent. A fixture whose meaning
  depends on what some model did last Tuesday is a snapshot, not a
  specification test, and no mode exists to create one.
- **Transport framing.** The bytes are framed by each lane's own reader. A
  fixture cannot ask for a malformed SSE frame or a keep-alive comment; those
  belong in each reader's unit tests.
- **Protobuf.** Byte-level parity between implementations is pinned by the
  shared corpus in `sdks/typescript/packages/proto/__tests__/__fixtures__/bytes`.
- **Python.** There is no Python client to hold to this.

## The corpus gate

`spec/harness/conformance.test.ts` checks what is true of the corpus itself:
that each file is well formed, that every divergence override explains itself,
and that the behaviours this suite exists to pin still have a fixture. If you
rename a fixture that gate names, update it in the same commit — deliberately.
