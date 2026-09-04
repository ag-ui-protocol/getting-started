/**
 * Emits the human-readable schema reference page, docs/spec/draft/schema.mdx,
 * from the same model every SDK is generated from.
 *
 * The page exists so the prose specification can link a field's shape instead
 * of restating it: every definition gets a stable anchor (its name,
 * lowercased), and the prose pages point at those. It is generated — and
 * drift-gated like every other output — because a hand-maintained copy of 82
 * definitions would rot the first week nobody was looking.
 */
import type {
  AliasDefinition,
  Definition,
  EnumDefinition,
  Field,
  ObjectDefinition,
  ProtocolModel,
  TypeExpr,
  UnionDefinition,
} from "./ir";

/**
 * MDX treats `{` as the start of an expression and `<` as the start of a tag,
 * so both are escaped in prose positions. The schema's descriptions contain
 * neither today; the escape is what keeps a future description from breaking
 * the docs build instead of the drift gate.
 */
const mdx = (text: string): string =>
  text.replace(/\{/g, "&#123;").replace(/</g, "&lt;");

/** The anchor a definition's heading gets: github-slugger on a code span. */
const slug = (name: string): string => name.toLowerCase();

const link = (name: string): string => `[\`${name}\`](#${slug(name)})`;

const renderType = (type: TypeExpr): string => {
  switch (type.kind) {
    case "string":
      return type.pattern === undefined
        ? "`string`"
        : `\`string\` matching \`${type.pattern}\``;
    case "integer": {
      const bounds = [
        type.minimum === undefined ? undefined : `min ${type.minimum}`,
        type.maximum === undefined ? undefined : `max ${type.maximum}`,
      ].filter((part) => part !== undefined);
      return bounds.length === 0
        ? "`integer`"
        : `\`integer\` (${bounds.join(", ")})`;
    }
    case "boolean":
      return "`boolean`";
    case "any":
      return "any JSON value";
    case "openMap":
      return "`object`, open by key";
    case "literal":
      return type.enumRef === undefined
        ? `\`"${type.value}"\``
        : `\`"${type.value}"\` (${link(type.enumRef)})`;
    case "ref":
      return link(type.name);
    case "stringEnum":
      return type.values.map((value) => `\`"${value}"\``).join(" | ");
    case "array": {
      const items = renderType(type.items);
      const bound = type.minItems === undefined ? "" : ` (min ${type.minItems})`;
      return `array of ${items}${bound}`;
    }
    case "union":
      return type.members.map(renderType).join(" | ");
  }
};

const renderField = (field: Field): string => {
  const parts = [
    `- \`${field.name}\` — ${renderType(field.type)}, ${
      field.required ? "**required**" : "optional"
    }.`,
  ];
  if (field.description !== "") parts.push(mdx(field.description));
  if (field.defaultValue !== undefined)
    parts.push(`Default: \`${JSON.stringify(field.defaultValue)}\`.`);
  if (field.contentEncoding !== undefined)
    parts.push(`Encoding: \`${field.contentEncoding}\`.`);
  const itemsDescription =
    field.type.kind === "array" ? field.type.itemsDescription : undefined;
  if (itemsDescription !== undefined && itemsDescription !== "")
    parts.push(`Each entry: ${mdx(itemsDescription)}`);
  return parts.join(" ");
};

const renderObject = (
  definition: ObjectDefinition,
  options?: { omitClosedness?: boolean },
): string => {
  const lines: string[] = [];
  if (definition.fields.length > 0) {
    lines.push("**Fields:**", "");
    for (const field of definition.fields) lines.push(renderField(field));
    lines.push("");
  }
  // A mixin's openness is a composition artefact, not a wire contract — no
  // wire object is ever just a mixin — so the mixin section omits the line.
  if (options?.omitClosedness !== true) {
    lines.push(
      definition.closed
        ? "Closed object: the schema rejects members not listed here."
        : "Open object: members beyond these are protocol-legal and are never stripped.",
    );
  }
  if (definition.composedMixins.length > 0) {
    lines.push(
      "",
      `Composes ${definition.composedMixins.map(link).join(", ")}; the composed fields are listed above.`,
    );
  }
  return lines.join("\n");
};

const renderUnion = (definition: UnionDefinition): string => {
  const lines = ["**Members:**", ""];
  for (const member of definition.members) lines.push(`- ${link(member)}`);
  if (definition.discriminator !== undefined) {
    lines.push("", `Discriminated by \`${definition.discriminator}\`.`);
  }
  return lines.join("\n");
};

const renderEnum = (definition: EnumDefinition): string =>
  [
    "**Values:**",
    "",
    definition.values.map((value) => `\`${value}\``).join(" · "),
  ].join("\n");

const renderAlias = (definition: AliasDefinition): string =>
  `**Type:** ${renderType(definition.type)}`;

const renderDefinition = (
  definition: Definition,
  options?: { omitClosedness?: boolean },
): string => {
  const body = (() => {
    switch (definition.kind) {
      case "object":
        return renderObject(definition, options);
      case "union":
        return renderUnion(definition);
      case "enum":
        return renderEnum(definition);
      case "alias":
        return renderAlias(definition);
    }
  })();
  const description =
    definition.description === "" ? [] : [mdx(definition.description), ""];
  return [`### \`${definition.name}\``, "", ...description, body].join("\n");
};

interface Section {
  title: string;
  intro: string;
  definitions: Definition[];
}

/**
 * The page's sections, computed from the model rather than hand-listed: the
 * event and message unions name their members, run-input material is what its
 * names say, outcomes and interrupts are the run-ending vocabulary, and
 * whatever remains is a common type. A new definition always lands somewhere,
 * so adding one to the schema never requires touching this file.
 */
const sectionize = (model: ProtocolModel): Section[] => {
  const byName = new Map(model.definitions.map((d) => [d.name, d]));
  const union = (name: string): string[] => {
    const definition = byName.get(name);
    return definition?.kind === "union" ? definition.members : [];
  };

  const events = new Set(["Event", "EventType", ...union("Event")]);
  const messages = new Set([
    "Message",
    "Role",
    "TextMessageRole",
    ...union("Message"),
  ]);
  const input = new Set(
    ["RunAgentInput", "Tool", "Context", "ResumeEntry"].concat(
      model.definitions
        .map((d) => d.name)
        .filter((name) => name.includes("InputContent")),
    ),
  );
  const outcomes = new Set(
    model.definitions
      .map((d) => d.name)
      .filter((name) => name.includes("Outcome") || name === "Interrupt"),
  );

  // Two of the four sets are computed by substring, so nothing stops a name
  // from matching both — and a definition in two sets is rendered twice, under
  // two headings, with the same anchor. The last section takes whatever is
  // left over, so it cannot overlap; these four can.
  const named: Array<[string, Set<string>]> = [
    ["Events", events],
    ["Messages", messages],
    ["Run Input", input],
    ["Outcomes and Interrupts", outcomes],
  ];
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const both = [...named[i][1]].filter((name) => named[j][1].has(name));
      if (both.length > 0) {
        throw new Error(
          `${both.join(", ")} would be rendered in both "${named[i][0]}" and ` +
            `"${named[j][0]}", twice on the page and twice under the same anchor — ` +
            "narrow whichever rule claims it by mistake",
        );
      }
    }
  }

  const pick = (names: Set<string>): Definition[] =>
    model.definitions.filter((d) => names.has(d.name));
  const claimed = new Set([...events, ...messages, ...input, ...outcomes]);

  return [
    {
      title: "Events",
      intro:
        "The event union, its discriminator, and every event. The mixins their fields come from are listed under [Mixins](#mixins).",
      definitions: pick(events),
    },
    {
      title: "Messages",
      intro: "The message union and the message types conversation history holds.",
      definitions: pick(messages),
    },
    {
      title: "Run Input",
      intro:
        "The request that starts a run, and the types only it carries. Behaviour: [Run Input](/spec/draft/basic/run-input).",
      definitions: pick(input),
    },
    {
      title: "Outcomes and Interrupts",
      intro:
        "How runs and subagents report ending, and what an interrupted run is waiting for. Behaviour: [Interrupts and Resume](/spec/draft/basic/patterns/interrupt-resume).",
      definitions: pick(outcomes),
    },
    {
      title: "Common Types",
      intro: "Everything the sections above share.",
      definitions: model.definitions.filter((d) => !claimed.has(d.name)),
    },
  ];
};

export function emitSchemaReference(model: ProtocolModel): string {
  const sections = sectionize(model)
    .filter((section) => section.definitions.length > 0)
    .map((section) =>
      [
        `## ${section.title}`,
        "",
        section.intro,
        "",
        section.definitions
          .map((definition) => renderDefinition(definition))
          .join("\n\n"),
      ].join("\n"),
    );

  const mixins = model.mixinShapes.map((shape) =>
    renderDefinition({ ...shape, composedMixins: [] }, { omitClosedness: true }),
  );

  return [
    "---",
    'title: "Schema Reference"',
    `description: "Every definition of the ${model.version} schema, one anchor each — generated, do not edit"`,
    "---",
    "",
    // Frontmatter has to be the first bytes of an .mdx page, so the
    // @generated banner every other output leads with sits directly after it,
    // as an MDX comment. The harness knows this exception.
    `{/* @generated from ${model.schemaId} — DO NOT EDIT. Change the schema and regenerate. */}`,
    "",
    'import DraftBanner from "/snippets/spec-draft-banner.mdx";',
    "",
    "<DraftBanner />",
    "",
    "This page is generated from the machine-readable schema at",
    `[\`/spec/${model.version}/schema.json\`](/spec/${model.version}/schema.json) — the source of truth for`,
    "structure — so the prose specification can link a definition instead of",
    "restating it. Do not edit it by hand: change the schema and regenerate.",
    "",
    "Each definition's anchor is its name, lowercased.",
    "",
    sections.join("\n\n"),
    "",
    "## Mixins",
    "",
    "Shared field sets, flattened into every definition that composes them. They",
    "exist in the schema as named definitions so their documentation lives once;",
    "no wire object is ever just a mixin.",
    "",
    mixins.join("\n\n"),
    "",
  ].join("\n");
}
