# The AG-UI specification

The protocol's contract as JSON Schema, and the suite that checks it.

Nothing here is published to a package registry. The artifact is `draft/schema.json`,
served on the web; this project exists to make sure it says what it means.

## Layout

```
draft/
  schema.json        the contract: 31 events and everything they reference
  json-patch.json    RFC 6902, kept separate because it is someone else's standard
  fixtures/          documents that must be accepted, and documents that must not
harness/             the suite
tools/reconcile.ts   builds RECONCILIATION.md
RECONCILIATION.md    what each SDK requires today, against what the schema settled on
```

## Addressing a definition

`schema.json` validates an AG-UI event. Every definition inside it also has an
anchor, so it can be referenced on its own:

```
https://ag-ui.com/spec/draft/schema.json                        an event
https://ag-ui.com/spec/draft/schema.json#RunAgentInput          the request body
https://ag-ui.com/spec/draft/schema.json#TextMessageStartEvent  one event type
https://ag-ui.com/spec/draft/json-patch.json#JsonPatch          a patch document
```

The version lives in the `$id`s and nowhere else in the artifact, so freezing a
version means rewriting the `$id` of each of the two files — and the generated
protocol constant follows from that. Both have to move together: `schema.json`
reaches JSON Patch by a relative reference, so a `schema.json` stamped `1.0`
resolves it to `/spec/1.0/json-patch.json`, which only exists if that file was
stamped too. The harness has its own copy of the two identifiers, which a version
cut has to update as well.

## Adding a fixture

Drop a file in. There is no test to write.

```
draft/fixtures/<Definition>/valid/<what-it-shows>.json
draft/fixtures/<Definition>/invalid/<what-it-shows>.json
draft/fixtures/<Definition>/invalid/<what-it-shows>.expect.json
```

`<Definition>` is the anchor name — `TextMessageContentEvent`, `RunAgentInput` —
and the document is validated against that definition alone rather than against
the whole union, so a failure points at one rule instead of thirty-one.

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
rule — the three union fixtures do exactly that.

The easiest way to get these values is to write the document, run the suite, and
read the reported errors out of the failure message.

## What the suite checks

Beyond the fixtures:

- both files validate against the 2020-12 meta-schema
- every definition **compiles**, not merely loads — strict mode's unknown-keyword
  check runs at compile time, so a misspelled keyword in a corner nothing
  compiled would otherwise sit there unreported
- a misspelled keyword still fails, despite `$anchor` being declared to ajv
- every anchor resolves, so the published addresses above actually work
- every reference resolves, with nothing dangling
- the union has exactly 31 members, matching the definitions and the `EventType` enum
- each event's definition accepts its own documents and rejects the other thirty
- every field name is camelCase and carries a description
- no keyword outside the standard vocabulary, and no closed object anywhere
- every valid event fixture also validates against `schema.json` itself, not only
  against its own definition
- each definition's exact property set and required set, every union's members,
  every enum's members and every fixed value, all pinned by hand — each with a
  coverage check, so a definition, union, enum or `const` nobody pinned fails
- the constraint operands — `type`, `pattern`, `minimum`, `maximum`, `minItems`,
  `default`, `contentEncoding` and every `$ref` target — held in a snapshot, since
  they are too numerous to spell out and too load-bearing to leave unchecked.
  Descriptions are excluded, so a wording change does not churn it
- the keyword vocabulary, so a keyword the harness does not model cannot appear
  without someone deciding to teach it first

The last one is load-bearing rather than pedantic. The wire contract is open, so
an unrecognised property is never a validation failure — which means nothing in
the schema itself would catch a property that was simply never written down. Once
the SDKs are generated from this file, those lists become what the compatibility
boundary strips against, so a field missing here would be quietly removed from the
wire rather than failing loudly. The coverage check matters just as much: without
it the pin was only as good as what came to mind when it was written, and dropping
`required: ["type"]` from `RunFinishedSuccessOutcome` left the whole suite green
while making `"outcome": {}` a valid `RUN_FINISHED`.

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
  these four the SDKs declare `unknown`, so a number validates here and would not
  on a message. The schema follows the SDKs.
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
  `if`/`then`, which this schema does not use for the reasons above. It is a
  behavioural rule, and belongs in the prose specification.
- **The `timestamp` unit is not stated.** Every SDK that sets it uses milliseconds
  since the Unix epoch, but nothing says so normatively, so a producer using
  seconds validates and is misread.
- **Outcome objects forbid their sibling's field.** Objects are otherwise open
  everywhere, but a success outcome carrying `interrupts` is a contradiction
  rather than a forward-compatible extension — a consumer branching on the
  discriminator would finish the run with an interrupt still pending.

## Commands

```bash
pnpm --filter @ag-ui/spec test        # the suite
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
