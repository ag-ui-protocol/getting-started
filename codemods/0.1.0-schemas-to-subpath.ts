/**
 * jscodeshift codemod: @ag-ui/core 0.0.x → 0.1.0
 *
 * Moves imports that no longer live on the main `@ag-ui/core` entry to the new
 * `@ag-ui/core/schemas` subpath:
 *
 *   - every `*Schema` export (and `EventSchemas`)
 *   - every `create*Event` factory — these validate through zod, so they moved
 *     with the schemas to keep the main entry dependency-free
 *
 * Type-only imports are preserved. Idempotent.
 *
 * Usage:
 *   npx jscodeshift -t 0.1.0-schemas-to-subpath.ts --parser=tsx --extensions=ts,tsx src/
 */
import type { Transform, ImportSpecifier, ImportNamespaceSpecifier } from "jscodeshift";

// ---------------------------------------------------------------------------
// Curated list — the public *Schema exports from 0.0.x.
// The transform also matches anything whose imported name ends with "Schema"
// as a fallback, so this list does not need to be exhaustive. It exists to
// catch `EventSchemas` (the only "Schemas" plural export) and to make the
// intent of the transform explicit.
// Keep in sync with sdks/typescript/packages/core/src/schemas.ts
// ---------------------------------------------------------------------------
const SCHEMA_NAMES = new Set([
  // Discriminated event union
  "EventSchemas",
  // EventType enum schema
  "EventTypeSchema",
  // Base type schemas
  "FunctionCallSchema",
  "ToolCallSchema",
  "TextInputContentSchema",
  "InputContentDataSourceSchema",
  "InputContentUrlSourceSchema",
  "InputContentSourceSchema",
  "ImageInputContentSchema",
  "AudioInputContentSchema",
  "VideoInputContentSchema",
  "DocumentInputContentSchema",
  "ImageInputPartSchema",
  "AudioInputPartSchema",
  "VideoInputPartSchema",
  "DocumentInputPartSchema",
  "BinaryInputContentSchema",
  "InputContentSchema",
  "InputContentPartSchema",
  "DeveloperMessageSchema",
  "SystemMessageSchema",
  "AssistantMessageSchema",
  "UserMessageSchema",
  "ToolMessageSchema",
  "ActivityMessageSchema",
  "ReasoningMessageSchema",
  "MessageSchema",
  "RoleSchema",
  "ContextSchema",
  "ToolSchema",
  "InterruptSchema",
  "ResumeEntrySchema",
  "RunAgentInputSchema",
  "StateSchema",
  // Event schemas
  "BaseEventSchema",
  "TextMessageStartEventSchema",
  "TextMessageContentEventSchema",
  "TextMessageEndEventSchema",
  "TextMessageChunkEventSchema",
  "ThinkingTextMessageStartEventSchema",
  "ThinkingTextMessageContentEventSchema",
  "ThinkingTextMessageEndEventSchema",
  "ToolCallStartEventSchema",
  "ToolCallArgsEventSchema",
  "ToolCallEndEventSchema",
  "ToolCallResultEventSchema",
  "ToolCallChunkEventSchema",
  "ThinkingStartEventSchema",
  "ThinkingEndEventSchema",
  "StateSnapshotEventSchema",
  "StateDeltaEventSchema",
  "MessagesSnapshotEventSchema",
  "ActivitySnapshotEventSchema",
  "ActivityDeltaEventSchema",
  "RawEventSchema",
  "CustomEventSchema",
  "RunStartedEventSchema",
  "RunFinishedSuccessOutcomeSchema",
  "RunFinishedInterruptOutcomeSchema",
  "RunFinishedOutcomeSchema",
  "RunFinishedEventSchema",
  "RunErrorEventSchema",
  "StepStartedEventSchema",
  "StepFinishedEventSchema",
  "ReasoningEncryptedValueSubtypeSchema",
  "ReasoningStartEventSchema",
  "ReasoningMessageStartEventSchema",
  "ReasoningMessageContentEventSchema",
  "ReasoningMessageEndEventSchema",
  "ReasoningMessageChunkEventSchema",
  "ReasoningEndEventSchema",
  "ReasoningEncryptedValueEventSchema",
  // Capability schemas
  "SubAgentInfoSchema",
  "IdentityCapabilitiesSchema",
  "TransportCapabilitiesSchema",
  "ToolsCapabilitiesSchema",
  "OutputCapabilitiesSchema",
  "StateCapabilitiesSchema",
  "MultiAgentCapabilitiesSchema",
  "ReasoningCapabilitiesSchema",
  "MultimodalInputCapabilitiesSchema",
  "MultimodalOutputCapabilitiesSchema",
  "MultimodalCapabilitiesSchema",
  "ExecutionCapabilitiesSchema",
  "HumanInTheLoopCapabilitiesSchema",
  "AgentCapabilitiesSchema",
]);

// The validating event factories moved to the subpath alongside the schemas —
// they call `schema.parse(...)`, which needs zod. Matched by shape rather than a
// second curated list; the transform only ever rewrites imports that were already
// coming from "@ag-ui/core", so an unrelated local `createFooEvent` is unaffected.
const FACTORY_PATTERN = /^create[A-Z][A-Za-z0-9]*Event$/;

/** Returns true if this imported name should move to @ag-ui/core/schemas. */
const isSchemaSpecifier = (importedName: string): boolean =>
  importedName.endsWith("Schema") ||
  importedName === "EventSchemas" ||
  SCHEMA_NAMES.has(importedName) ||
  FACTORY_PATTERN.test(importedName);

const CORE_SOURCE = "@ag-ui/core";
const SCHEMAS_SOURCE = "@ag-ui/core/schemas";

const transform: Transform = (file, api) => {
  const j = api.jscodeshift;
  const root = j(file.source);

  let dirty = false;

  // Collect all import declarations from @ag-ui/core
  const coreImports = root.find(j.ImportDeclaration, {
    source: { value: CORE_SOURCE },
  });

  if (coreImports.length === 0) {
    return file.source;
  }

  // Collect any existing import from @ag-ui/core/schemas so we can merge into it
  const existingSchemasImports = root.find(j.ImportDeclaration, {
    source: { value: SCHEMAS_SOURCE },
  });

  // We may need to merge schema specifiers into an existing schemas import.
  // Build a set of (imported::local) pairs already imported from @ag-ui/core/schemas
  // so we don't create duplicates. Keying by both imported name AND local alias ensures
  // that `Foo` and `Foo as Bar` are treated as distinct specifiers and both preserved.
  const alreadyInSchemas = new Set<string>();
  existingSchemasImports.forEach((path) => {
    (path.node.specifiers ?? []).forEach((spec) => {
      if (spec.type === "ImportSpecifier") {
        const s = spec as ImportSpecifier;
        alreadyInSchemas.add(`${s.imported.name}::${s.local.name}`);
      }
    });
  });

  // Specifiers to move to @ag-ui/core/schemas, accumulated across all @ag-ui/core imports.
  // We separate value specs from type-only specs so we can emit correctly typed declarations.
  const valueSpecsToMove: ImportSpecifier[] = [];
  const typeSpecsToMove: ImportSpecifier[] = [];

  coreImports.forEach((path) => {
    const specifiers = path.node.specifiers ?? [];
    // A whole-declaration `import type { ... }` makes all specifiers type-only.
    const declIsTypeOnly = path.node.importKind === "type";

    // Partition: stay vs. move
    const staySpecs: typeof specifiers = [];
    const moveSpecs: ImportSpecifier[] = [];

    for (const spec of specifiers) {
      if (spec.type !== "ImportSpecifier") {
        // Default or namespace imports — always stay on @ag-ui/core
        if (spec.type === "ImportNamespaceSpecifier") {
          console.warn(
            `[codemod 0.1.0-schemas-to-subpath] ${file.path}: namespace import "import * as ${(spec as ImportNamespaceSpecifier).local.name} from "@ag-ui/core"" cannot be automatically migrated. Schema references via ${(spec as ImportNamespaceSpecifier).local.name}.<SchemaName> must be updated manually.`
          );
        }
        staySpecs.push(spec);
        continue;
      }
      const named = spec as ImportSpecifier;
      const importedName = named.imported.name;

      if (isSchemaSpecifier(importedName)) {
        moveSpecs.push(named);
      } else {
        staySpecs.push(named);
      }
    }

    if (moveSpecs.length === 0) {
      // Nothing to move in this declaration — leave it untouched
      return;
    }

    dirty = true;

    // Only add to specsToMove if not already present in @ag-ui/core/schemas.
    // Preserve type-only intent: a specifier is type-only if the whole declaration
    // is `import type { ... }` OR if the individual specifier has importKind "type".
    // Uniqueness key is `${imported.name}::${local.name}` so that the same schema
    // imported under two different local aliases (e.g. `Foo` and `Foo as Bar`)
    // are both preserved rather than the second being silently dropped.
    for (const spec of moveSpecs) {
      const importedName = spec.imported.name;
      const localName = spec.local.name;
      const dedupKey = `${importedName}::${localName}`;
      if (!alreadyInSchemas.has(dedupKey)) {
        const specIsTypeOnly = declIsTypeOnly || spec.importKind === "type";
        if (specIsTypeOnly) {
          // Clone spec without per-specifier importKind — the declaration itself
          // will be emitted as `import type { ... }`, so the per-specifier marker
          // is redundant and would produce `import type { type Foo }`.
          const cloned = j.importSpecifier(
            j.identifier(importedName),
            j.identifier(localName),
          );
          typeSpecsToMove.push(cloned);
        } else {
          valueSpecsToMove.push(spec);
        }
        alreadyInSchemas.add(dedupKey);
      }
    }

    // Update or remove the original @ag-ui/core declaration
    if (staySpecs.length === 0) {
      // Nothing left on @ag-ui/core — remove the declaration entirely
      j(path).remove();
    } else {
      // Mutate the specifier list in-place
      path.node.specifiers = staySpecs;
      // If the declaration was `import type` but we stripped all type-only specs
      // and only non-schema (value) specifiers remain, the importKind stays "type"
      // which is still correct since all remaining specifiers are type imports.
    }
  });

  const specsToMove = [...valueSpecsToMove, ...typeSpecsToMove];

  if (!dirty || specsToMove.length === 0) {
    return dirty ? root.toSource({ quote: "double" }) : file.source;
  }

  // Helper to insert a new import declaration after the last remaining import.
  const insertAfterLastImport = (newImport: ReturnType<typeof j.importDeclaration>) => {
    const allImports = root.find(j.ImportDeclaration);
    if (allImports.length > 0) {
      allImports.at(allImports.length - 1).insertAfter(newImport);
    } else {
      const body = root.find(j.Program).get("body");
      body.value.unshift(newImport);
    }
  };

  if (existingSchemasImports.length > 0) {
    // Merge specifiers only into a declaration of the matching kind to avoid
    // accidentally making value imports type-only (erased at runtime) or
    // making type imports lose their type-only status.
    //
    // Strategy:
    //   - typeSpecsToMove → merge into an existing `import type` declaration,
    //     or create a new one if none exists.
    //   - valueSpecsToMove → merge into an existing value import declaration,
    //     or create a new one if none exists.
    //
    // We never mix kinds within a single declaration.

    let mergedValue = false;
    let mergedType = false;

    existingSchemasImports.forEach((path) => {
      if (path.node.importKind === "type") {
        // Type-only declaration: only merge type specs here.
        if (typeSpecsToMove.length > 0 && !mergedType) {
          path.node.specifiers = [...(path.node.specifiers ?? []), ...typeSpecsToMove];
          mergedType = true;
        }
        // Do NOT merge value specs — they would become type-only and be erased at runtime.
      } else {
        // Value import declaration: only merge value specs here.
        if (valueSpecsToMove.length > 0 && !mergedValue) {
          path.node.specifiers = [...(path.node.specifiers ?? []), ...valueSpecsToMove];
          mergedValue = true;
        }
        // Do NOT merge type specs into a value import — emit a separate `import type` below.
      }
    });

    // Anything not yet merged needs a fresh declaration.
    if (!mergedValue && valueSpecsToMove.length > 0) {
      const newImport = j.importDeclaration(valueSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
      insertAfterLastImport(newImport);
    }
    if (!mergedType && typeSpecsToMove.length > 0) {
      const typeImport = j.importDeclaration(typeSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
      typeImport.importKind = "type";
      insertAfterLastImport(typeImport);
    }
  } else {
    // No existing @ag-ui/core/schemas import. Emit value and type declarations separately.
    if (valueSpecsToMove.length > 0) {
      const newImport = j.importDeclaration(valueSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
      insertAfterLastImport(newImport);
    }
    if (typeSpecsToMove.length > 0) {
      const typeImport = j.importDeclaration(typeSpecsToMove, j.stringLiteral(SCHEMAS_SOURCE));
      typeImport.importKind = "type";
      insertAfterLastImport(typeImport);
    }
  }

  return root.toSource({ quote: "double" });
};

export default transform;
export const parser = "tsx";
