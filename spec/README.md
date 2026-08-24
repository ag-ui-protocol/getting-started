# The AG-UI specification

The protocol's contract as JSON Schema, and the suite that checks it.

Nothing here is published to a package registry. The artifact is `draft/schema.json`,
served on the web; this project exists to make sure it says what it means.

## Layout

```
draft/
  schema.json        the contract: the events and everything they reference
  fixtures/          documents that must be accepted, and documents that must not
  proto-freeze.txt   the binary wire's number ledger: append-only, generator-maintained
harness/             the suite
generator/           schema in, generated source files out, deterministic
tools/reconcile.ts   builds RECONCILIATION.md
RECONCILIATION.md    what each SDK requires today, against what the schema settled on
```

## Exact objects, forgiving receivers

The schema is a definition, not a gate: it says exactly what exists in this
version of the protocol, so every object is closed with
`unevaluatedProperties: false` and a property the schema does not declare fails
validation. Compatibility across versions is the receiver's job, specified as
behaviour rather than as shape: an SDK boundary tolerates fields it does not
recognise — stripping them with a warning rather than rejecting the stream —
because an unknown field from a newer minor version and a typo look identical
to a validator, and only the receiver's own version makes the difference
meaningful. That rule lives in the prose specification; a validator has no way
to express strip-and-warn, so this file does not try.

Two consequences worth knowing. Validating live traffic against this file with
an off-the-shelf validator is a same-version conformance check, not a
compatibility check: a stream from a newer producer will be rejected for
carrying fields this copy has never heard of, so validate with a schema version
at least as new as the producer's. And the property lists in this file are
load-bearing beyond validation: once the SDKs are generated from it, they are
what the compatibility boundary strips against, so a field missing here is a
field that gets quietly removed from the wire.

The exceptions, each open for a stated reason, are pinned by the suite: the
mixins (`BaseEvent`, `Attributable`, `BaseMessage`), which are composed into
definitions that close the whole shape; the RFC 6902 operations, which stay
open because the RFC requires members an operation does not define to be
ignored rather than rejected; and the open-by-key objects — `Metadata`,
activity `content`, `Interrupt.responseSchema` — where arbitrary keys are the
data itself rather than unrecognised fields, pinned by exact location.

## Addressing a definition

`schema.json` validates an AG-UI event. Every definition inside it also has an
anchor, so it can be referenced on its own:

```
https://ag-ui.com/spec/draft/schema.json                        an event
https://ag-ui.com/spec/draft/schema.json#RunAgentInput          the request body
https://ag-ui.com/spec/draft/schema.json#TextMessageStartEvent  one event type
https://ag-ui.com/spec/draft/schema.json#JsonPatch              a patch document
```

The file is self-contained — the JSON Patch definitions are inlined rather than
referenced from a second file — so downloading it is all a consumer needs to
validate, and freezing a version means rewriting the one `$id`. The harness has
its own copy of the identifier, which a version cut has to update as well.

When a document is rejected and the reason is not obvious, validate it against
the event's own anchor rather than against the file root: the root is a union,
so a generic validator reports one error per failed branch, and the branch that
names the real problem drowns among the others.

## Adding a fixture

Drop a file in. There is no test to write.

```
draft/fixtures/<Definition>/valid/<what-it-shows>.json
draft/fixtures/<Definition>/invalid/<what-it-shows>.json
draft/fixtures/<Definition>/invalid/<what-it-shows>.expect.json
```

`<Definition>` is the anchor name — `TextMessageContentEvent`, `RunAgentInput` —
and the document is validated against that definition alone rather than against
the whole union, so a failure points at one rule instead of every branch.

Every rejected document needs an `.expect.json` beside it naming the rule that
rejected it and where:

```json
{
  "keyword": "type",
  "instanceLocation": "/timestamp",
  "keywordLocation": "#/properties/timestamp/type"
}
```

That requirement is the difference between a real test and a false green: a
document that fails for an unrelated reason would still fail if the rule under
test disappeared. `keyword` and `instanceLocation` are the vocabulary JSON
Schema 2020-12's own output format uses; the harness translates ajv's reporting
into it.

`keywordLocation` names the rule, and it is there because the other two do not
identify one: inside a union every branch reports the same keyword at the same
instance location, so an expectation could be satisfied by a sibling branch
rather than the rule being tested. When the point of a fixture is that no branch
accepted the document, assert the union's own `oneOf` rather than a branch's
rule — the union fixtures do exactly that.

The easiest way to get these values is to write the document, run the suite, and
read the reported errors out of the failure message.

## What the suite checks

Beyond the fixtures:

- the file validates against the 2020-12 meta-schema
- every definition **compiles**, not merely loads — strict mode's unknown-keyword
  check runs at compile time, so a misspelled keyword in a corner nothing
  compiled would otherwise sit there unreported
- a misspelled keyword still fails, despite `$anchor` being declared to ajv
- every anchor resolves, so the published addresses above actually work
- every reference resolves within the file, with nothing dangling and nothing
  pointing at a second file
- the event union, the event definitions and the `EventType` enum agree exactly
- each event's definition accepts its own documents and rejects every other
  event's
- every field name is camelCase and carries a description
- every shaped definition is closed, except the ones on the documented open
  list, and nothing closes an object through a side door — a schema-valued
  `additionalProperties`, a `not`, a boolean-false property
- every valid event fixture also validates against `schema.json` itself, not only
  against its own definition
- the keyword vocabulary is pinned, so a keyword the harness does not model
  cannot appear without someone deciding to teach it first

The schema itself is the single source of truth for the protocol's shape:
there is no second hand-maintained copy of what each definition declares and
requires, so a shape change is caught by review of the schema diff and by
whichever fixtures exercise the changed rule — not by a failing pin. Closure
is what makes undeclared properties fail loudly rather than pass silently;
for everything else, a rule only has a regression test if a fixture exercises
it, which is the standing invitation to add one when a rule matters.

## Known divergences

Places where the schema and the SDKs, or the schema and the ticket that
commissioned it, do not line up. Recorded here because each is a decision that
could reasonably have gone the other way, and a reader finding one should be able
to tell it apart from an oversight.

- **`Interrupt.responseSchema` is an object.** TypeScript and Python both declare
  it that way; .NET holds it as any JSON, and the ticket lists it among the
  arbitrary-JSON fields. Following the two that constrain it keeps the schema from
  accepting documents the reference client rejects, at the price of rejecting the
  boolean schemas JSON Schema permits — `true`, meaning any answer is acceptable.
- **Media-part `metadata` is unconstrained**, on the image, audio, video and
  document parts. Everywhere else in the protocol `metadata` is an object; on
  the media parts the SDKs declare `unknown`, so a number validates here and
  would not on a message. The schema follows the SDKs.
- **`Tool.parameters` accepts values that are not JSON Schemas.** It is one of the
  arbitrary-JSON fields by requirement, and TypeScript declares it `z.any()`, so a
  string or a number validates — while a consumer that compiles it as a schema
  will throw. Constraining it to an object or a boolean would be a protocol
  change, not a description of one.
- **`Interrupt.expiresAt` is an unconstrained string.** The ticket settled this,
  because producers already disagree about the representation and tightening it
  would reject streams that work today. The documented convention is ISO 8601, and
  the consequences of ignoring it are not symmetrical: the TypeScript client reads
  an unparseable value as never expiring, while a Python integration raises from
  `datetime.fromisoformat`. So a producer sending something else validates here and
  breaks somewhere else.
- **`Interrupt.toolCallId` is optional whatever the `reason`.** The documentation
  says a tool-approval interrupt carries one, and a consumer cannot correlate the
  approval without it — but `reason` is deliberately an open string, so there is no
  closed set of reasons to condition on, and a conditional requirement would need
  `if`/`then`, which this schema does not use. It is a behavioural rule, and
  belongs in the prose specification.
- **The `timestamp` unit is not stated.** Every SDK that sets it uses milliseconds
  since the Unix epoch, but nothing says so normatively, so a producer using
  seconds validates and is misread.

## Commands

```bash
pnpm --filter @ag-ui/spec test        # the suite
pnpm --filter @ag-ui/spec generate    # regenerate the TypeScript output from the schema
pnpm --filter @ag-ui/spec reconcile   # regenerate RECONCILIATION.md
```

## What this does not check

Anything about a sequence. A validator sees one document at a time, so event
ordering, the run lifecycle, what a consumer does with something it does not
recognise, cross-event consistency such as a `TOOL_CALL_END` matching a call that
was actually started, and whether a patch applies to the state it targets are all
out of reach. A structurally valid patch pointing at a path that does not exist is
still valid JSON Patch. Those are behavioural rules, specified and tested
separately.

## A note on ajv

`$anchor` is a core 2020-12 keyword and ajv resolves it correctly, but its
strict-mode allowlist omits it, so compiling an anchored definition fails with
"unknown keyword" unless the keyword is declared. The harness declares it, and
pins that doing so did not open a hole — a genuine misspelling still fails.

`strictRequired` is off. It is an ajv lint rather than a correctness check, and it
is wrong for composition: `required: ["id"]` on `DeveloperMessage` names a
property `BaseMessage` declares, which is how `allOf` is meant to work.
