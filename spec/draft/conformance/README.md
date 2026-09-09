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

## What this corpus is, and is not

It is a **regression suite for the first-party clients**, and it asserts two
different kinds of thing:

- **What the specification requires.** Every MUST and MUST NOT the streams
  exercise. A client failing one of these is non-conforming.
- **What these clients have chosen to do** where the specification leaves room.
  The spec says a consumer SHOULD warn about material it strips; ours do, and
  these fixtures hold them to it. It says a party MAY downgrade for an older
  peer; ours ship four era shims, and this ticket exists partly so that none of
  them survives untested. It says nothing about staying quiet on a clean
  stream; `conformant-run-is-quiet` demands it anyway, because a tolerance
  regression that starts complaining about legal traffic has no other guard.

So a fixture failing does not always mean a client is non-conforming — it
means a client changed. That is the point of a regression suite, and it is why
`kill` names a change rather than a rule.

- **What these clients do that the specification says they should NOT.** One
  fixture deliberately pins an admitted gap: `unknown-enum-value-role-fatal`,
  where a closed string set is checked as a leaf, so an unrecognised member is
  fatal on the TypeScript lane where the spec wants it stripped. Its
  description says so and names the spec Note that must change with it. It
  asserts the opposite of the rule, on purpose, so that closing the gap is a
  deliberate act rather than a silent one.

  It used to be two: `reasoning-discipline-not-verified` was an admitted gap
  alongside it, and now asserts the RULE on the TypeScript lane under the name
  `reasoning-discipline-verified` — a reasoning message is bracketed like any
  other. What is left of that divergence is on the .NET lane, recorded as
  `expectOverrides.dotnet` with a stated reason, which is the ordinary mechanism
  rather than an admission against the spec.

  Two more fixtures used to sit here, `run-error-first-admitted` and
  `late-run-error-after-finished-admitted`, on the reading that a client
  surfacing a producer's RUN_ERROR without failing the run was a gap. It is
  not: RUN_ERROR is delivered to the application and the stream continues, a
  RUN_STARTED after one begins a new run, and `runAgent()` resolves. They are
  named for that contract now — `run-error-first-run-continues`,
  `late-run-error-after-finished-run-continues` — and a third,
  `run-error-then-new-run-continues`, pins the in-stream restart end to end.

  The corpus gate's `required` list names those four fixtures, so flipping one
  back is a rename someone has to make on purpose. Two things it does not do:
  it does not name `unknown-enum-value-role-fatal` — the gap that
  is still open is held by its description alone, not by a `required` entry — and the fifth
  fixture it names in that neighbourhood, `unknown-outcome-array-fatal`, was
  never an admitted gap at all. That one pins the rule from the start: a
  malformed value in the outcome slot is fatal rather than stripped.

**If you ever point this corpus at a third-party client**, three groups need
relaxing: the SHOULD-level `warnings` and `noWarnings`; the `era-*` fixtures'
translation results, which the spec only permits; and the one admitted-gap
fixture above, which asserts behaviour the spec contradicts and whose `outcome`
and `errorContains` would wrongly fail a client that gets the rule right. Every
`expectOverrides.dotnet` block needs dropping too — those describe our .NET
client, not the protocol. What remains after that is conformance. Nothing in
the harness does this for you today, and nothing needs it until someone
actually runs a third-party client through it.

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

Then add the file name to `streams/MANIFEST.txt` (the corpus is pinned by a
committed listing, so an addition is as deliberate as a deletion) and run your
lane:

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

One exception to "verbatim": the TypeScript lane's replay server fills in a
`timestamp` when the event has none or carries `null`. So a fixture cannot
test what a client does with an *absent* timestamp — that belongs in each
client's own unit tests. A present-but-wrong one (a string, a float, a
negative) is passed through untouched and can be tested here. Every other
field is written exactly as you wrote it.

### `expect`

Every key is optional; state what the rule actually requires and nothing more.

| Key | Asserts |
| --- | --- |
| `outcome` | whether the **client** consumed the stream (`"completed"`) or rejected it (`"failed"`) — a producer `RUN_ERROR` is not a rejection: it is delivered as an event and pinned with `runError` |
| `errorContains` | substring of the error a client rejection surfaces |
| `runError` | the **run** reported its own failure: `true`, or a substring of the message |
| `eventTypes` | the exact ordered list of event types delivered to application code |
| `eventTypesAbsent` | types that must not reach application code |
| `eventPaths` | values inside delivered events, keyed `"<index>.<dotted path>"`, each must exist and equal |
| `eventAbsentPaths` | paths inside delivered events that must not exist |
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

**`outcome` does not count as an assertion on its own.** Every fixture has one,
and "the client consumed the stream" is what almost all of them say — so the
corpus gate requires a second effective key on each lane, and requires
`errorContains` (or `runError`) wherever a lane's resolved `outcome` is
`"failed"`. A bare `"failed"` is satisfied by any rejection, including one for
a reason that has nothing to do with the rule the fixture is named for.

`messages`, `state` and `request` are **subset** matches: arrays must be the
same length, objects are compared only on the keys you name. Assert what the
specification requires — an exact match would fail on incidentals the two
clients differ about for no interesting reason.

The four event keys are what let a fixture tell *dropped* from *delivered*.
Warnings and final messages cannot: a client that warns about stripping
something and then delivers it anyway satisfies both. `eventTypes` proves an
event survived; `eventPaths` and `eventAbsentPaths` prove what it survived
carrying, and are the only way to assert that something was removed.

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
    "intentional": "the .NET client has no enforcement stage, so nothing is stripped and it stays quiet here; alignment is tracked separately",
    "noWarnings": true
  }
}
```

**`"warnings": []` does not mean "no warnings".** Both runners read `warnings`
as "each of these substrings must appear somewhere", so an empty list asserts
nothing at all — it only *lifts* the base expectation. If you mean the lane
stays quiet, say `noWarnings: true`; if you mean the base's warning
requirement does not apply, `"warnings": []` is right, but then say so in
`intentional`. The same trap applies to `"request": {}` and any other empty
subset: an empty object matches every object.

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

Absence inside a **delivered event** is directly assertable with
`eventAbsentPaths`, and absence in the **sent request** with
`requestAbsentPaths`. What the subset matchers cannot express is absence
inside `messages` or `state` — there, use a shape a wrong implementation
cannot produce:

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

## A shim with no fixture

There are four version-gated compatibility shims and only three of them can be
tested here. The 0.0.45 shim translates the retired `THINKING_*` shapes — but
so does the always-on compatibility boundary, which runs innermost and handles
exactly the same five event types with the same output. In the shipped
pipeline the shim never sees one. Disabling either translator alone leaves
`era-0-0-45-thinking-translated` green; only disabling both fails it.

So that fixture pins the translation, not the shim. The shim is unreachable
code, which is a finding about the client rather than a gap in this corpus,
and no fixture can close it while the boundary exists.

## The corpus gate

`spec/harness/conformance.test.ts` checks what is true of the corpus itself:
that each file is well formed, that every top-level and expectation key is one
a runner actually reads, that every fixture asserts something beyond "the
stream was consumed", that a fixture expecting a failure says WHICH failure,
that every divergence override explains itself, and that the behaviours this
suite exists to pin still have a fixture. If you rename a fixture that gate
names, update it in the same commit — deliberately.

The directory listing is pinned by `streams/MANIFEST.txt`, asserted in both
directions. Adding or removing a fixture means regenerating it in the same
commit; the command is in that file's header. Without it, "has fixtures" was
satisfied by a single file, and a corpus that quietly shrank was invisible.

Two escape hatches exist in that gate, both named lists with a reason per
entry and a stale-pin check that fails once the entry stops applying:
`OUTCOME_ONLY` for a lane whose only surviving assertion is `outcome`, and
`FAILURE_WITHOUT_REASON` for a lane whose rejection message is not pinned
anywhere. Both are meant to shrink, and both are empty today: every entry
they once held was closed by giving the fixture a real observable.
