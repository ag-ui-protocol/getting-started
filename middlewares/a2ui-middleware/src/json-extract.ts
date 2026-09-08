import clarinet from "clarinet";

// Clarinet's CParser type doesn't include the `error` property that exists at runtime.
// We use this to clear errors and allow parsing to continue on partial JSON.
type CParserWithError = ReturnType<typeof clarinet.parser> & { error: unknown };

/**
 * Extract complete items from a partially-streamed JSON object.
 * Given partial JSON like `{"flights": [{"id":"1",...}, {"id":"2"` and dataKey "flights",
 * returns an array of all complete objects parsed so far, or null if none found.
 */
export function extractCompleteItems(partial: string, dataKey: string): unknown[] | null {
  const result = extractCompleteItemsWithStatus(partial, dataKey);
  return result?.items ?? null;
}

/**
 * Locate the start of the value for a TOP-LEVEL (root-depth=1) key in partial JSON.
 *
 * Returns the byte index of the first non-whitespace character AFTER the
 * key's colon, or -1 if the key hasn't been seen at the root level yet.
 *
 * This is JSON-aware (driven by clarinet, not raw `indexOf`), so a key with
 * the same name nested inside a component object (e.g. a component carrying
 * its own `data` field) is correctly ignored — only the top-level key at
 * `{"<key>": ...}` is matched.
 */
function findTopLevelValueStart(partial: string, key: string): number {
  const target = `"${key}"`;
  let i = 0;
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escape = false;

  while (i < partial.length) {
    const ch = partial[i];

    if (escape) {
      escape = false;
      i++;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      // Opening quote of a string token. Only at the root level
      // (objectDepth === 1, no enclosing array) can this be the top-level
      // key we're looking for. We confirm by:
      //   1. The substring at `i` equals `"<key>"`.
      //   2. The next non-whitespace character after the closing quote is
      //      ':' — distinguishing this from a value string that happens to
      //      equal the key spelling.
      if (objectDepth === 1 && arrayDepth === 0 && partial.startsWith(target, i)) {
        let j = i + target.length;
        while (j < partial.length && (partial[j] === " " || partial[j] === "\n" || partial[j] === "\r" || partial[j] === "\t")) {
          j++;
        }
        if (j < partial.length && partial[j] === ":") {
          // Skip the colon and any whitespace to land on the value's first
          // non-whitespace character.
          j++;
          while (j < partial.length && (partial[j] === " " || partial[j] === "\n" || partial[j] === "\r" || partial[j] === "\t")) {
            j++;
          }
          return j < partial.length ? j : -1;
        }
      }
      inString = true;
      i++;
      continue;
    }

    if (ch === "{") objectDepth++;
    else if (ch === "}") objectDepth--;
    else if (ch === "[") arrayDepth++;
    else if (ch === "]") arrayDepth--;

    i++;
  }

  return -1;
}

/**
 * Extract a complete JSON object value for a given key from partially-streamed JSON.
 * Given partial JSON like `{"surfaceId": "s1", "data": {"form": {"name": "Alice"}}, "other":`
 * and dataKey "data", returns the parsed object `{"form": {"name": "Alice"}}` or null if
 * the object value is not yet fully closed.
 *
 * Only matches the key at the TOP LEVEL — a nested object that happens to
 * carry the same key (e.g. a component with its own `data` property) is
 * ignored. This keeps the streaming intercept correct even when component
 * payloads contain JSON keys that overlap with the render_a2ui arg names.
 */
export function extractCompleteObject(partial: string, dataKey: string): Record<string, unknown> | null {
  const braceStart = findTopLevelValueStart(partial, dataKey);
  if (braceStart === -1) return null;
  // findTopLevelValueStart returns the index of the value's opening token.
  // For object values that's the '{' character.
  if (partial[braceStart] !== "{") return null;

  // Use clarinet to find where the top-level object closes
  const substr = partial.substring(braceStart);
  const parser = clarinet.parser() as CParserWithError;

  let objectDepth = 0;
  let objectClosed = false;
  let closePosition = -1;

  parser.onerror = () => {
    parser.error = null;
  };

  parser.onopenobject = () => {
    objectDepth++;
  };

  parser.oncloseobject = () => {
    objectDepth--;
    if (objectDepth === 0 && !objectClosed) {
      objectClosed = true;
      closePosition = parser.position;
    }
  };

  // Need array tracking to handle nested arrays within the object
  parser.onopenarray = () => {};
  parser.onclosearray = () => {};
  parser.onvalue = () => {};
  parser.onkey = () => {};

  try {
    parser.write(substr);
  } catch {
    // Partial JSON will throw; that's expected
  }

  if (!objectClosed) return null;

  const objStr = substr.substring(0, closePosition);
  try {
    return JSON.parse(objStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extended version of extractCompleteItems that also reports whether the
 * array has been fully closed in the stream (i.e., the closing `]` has
 * been received).
 */
export function extractCompleteItemsWithStatus(
  partial: string,
  dataKey: string,
): { items: unknown[]; arrayClosed: boolean } | null {
  // Locate the opening '[' of the target array via a JSON-aware scan rather
  // than raw indexOf — a component object that happens to contain a key with
  // the same name (e.g. `"items"` deep in a component) must NOT be mistaken
  // for the top-level array.
  const bracketStart = findTopLevelValueStart(partial, dataKey);
  if (bracketStart === -1) return null;
  if (partial[bracketStart] !== "[") return null;

  // Feed only the array portion to clarinet, so parser.position is relative to bracketStart
  const substr = partial.substring(bracketStart);
  const parser = clarinet.parser() as CParserWithError;

  let objectDepth = 0;
  let arrayDepth = 0;
  let lastCompleteEnd = -1;
  let arrayClosed = false;

  parser.onerror = () => {
    parser.error = null;
  };

  parser.onopenarray = () => {
    arrayDepth++;
  };

  parser.onclosearray = () => {
    if (arrayDepth === 1) {
      arrayClosed = true;
    }
    arrayDepth--;
  };

  parser.onopenobject = () => {
    objectDepth++;
  };

  parser.oncloseobject = () => {
    if (objectDepth === 1 && arrayDepth === 1) {
      // Completed a top-level item in the target array.
      // parser.position is the 0-based index of the character AFTER the '}'.
      lastCompleteEnd = parser.position;
    }
    objectDepth--;
  };

  parser.onvalue = () => {
    // Primitive value at array top-level (number, string, bool, null)
    if (objectDepth === 0 && arrayDepth === 1) {
      lastCompleteEnd = parser.position;
    }
  };

  try {
    parser.write(substr);
  } catch {
    // Partial JSON will throw; that's expected
  }

  if (lastCompleteEnd === -1) return null;

  // substr.substring(0, lastCompleteEnd) gives everything from '[' up to and including '}'
  const arrayStr = substr.substring(0, lastCompleteEnd) + "]";
  try {
    const items = JSON.parse(arrayStr);
    return { items, arrayClosed };
  } catch {
    return null;
  }
}

/**
 * Incrementally extract complete items from the array at `data.<itemsKey>`
 * inside partially-streamed render_a2ui args.
 *
 * The render_a2ui args look like:
 *   `{"surfaceId":"s","components":[...],"data":{"items":[{...},{...}` (still streaming)
 *
 * We scope the search to the `data` object region first (so a `"items"` token
 * that appears inside a component's `path` string — e.g. `"path":"/items"` —
 * is never mistaken for the data array), then reuse the array-item extractor
 * to return every fully-closed item parsed so far.
 *
 * Returns `{ items, arrayClosed }` or null when the data array hasn't started
 * or no complete item exists yet.
 */
export function extractDataArrayItems(
  partial: string,
  itemsKey: string,
): { items: unknown[]; arrayClosed: boolean } | null {
  // Locate the TOP-LEVEL `data` object via clarinet so a component that
  // carries its own `data` field (e.g. a Chart component with
  // `{"id":"c","component":"Chart","data":{...}}`) doesn't get mis-scoped.
  const dataBraceStart = findTopLevelValueStart(partial, "data");
  if (dataBraceStart === -1) return null;
  if (partial[dataBraceStart] !== "{") return null;

  // Scope extraction to the data object substring so the items-array search
  // (now also clarinet-driven for top-level keys) is rooted at the data
  // object, never elsewhere in the args.
  const dataSubstr = partial.substring(dataBraceStart);
  return extractCompleteItemsWithStatus(dataSubstr, itemsKey);
}

/**
 * Extract a simple string field value from partial JSON.
 * Looks for `"key": "value"` and returns the value, or null if incomplete.
 */
export function extractStringField(partialJson: string, key: string): string | null {
  const parser = clarinet.parser() as CParserWithError;
  let result: string | null = null;
  let rootDepth = 0;
  let currentKey: string | null = null;
  let found = false;

  parser.onerror = () => {
    parser.error = null;
  };

  parser.onopenobject = (firstKey?: string) => {
    rootDepth++;
    if (firstKey !== undefined && rootDepth === 1) {
      currentKey = firstKey;
    }
  };

  parser.oncloseobject = () => {
    rootDepth--;
  };

  parser.onkey = (k: string) => {
    if (rootDepth === 1) {
      currentKey = k;
    }
  };

  parser.onvalue = (value: unknown) => {
    if (!found && rootDepth === 1 && currentKey === key && typeof value === "string") {
      result = value;
      found = true;
    }
  };

  try {
    parser.write(partialJson);
  } catch {
    // partial JSON
  }

  return result;
}

/**
 * Extract complete A2UI operation objects from the partially-streamed tool call args
 * for `send_a2ui_json_to_client`.
 *
 * The tool call args JSON looks like: `{"a2ui_json": "[{\"surfaceUpdate\":...}, ...]"}`
 * The `a2ui_json` value is a JSON-encoded string containing an array of operations.
 *
 * This function:
 * 1. Extracts the partial string value of `a2ui_json` from the partial outer JSON
 * 2. Unescapes JSON escape sequences to recover the inner JSON
 * 3. Finds complete top-level objects in the inner partial array
 */
export function extractCompleteA2UIOperations(partialArgs: string): Array<Record<string, unknown>> | null {
  // Phase 1: Find the start of the a2ui_json string value and unescape it.
  // We use manual parsing here because clarinet only emits complete string values,
  // but we need to work with the partial string as it streams in.
  const keyPattern = '"a2ui_json"';
  const keyIdx = partialArgs.indexOf(keyPattern);
  if (keyIdx === -1) return null;

  const afterKey = partialArgs.indexOf(":", keyIdx + keyPattern.length);
  if (afterKey === -1) return null;

  let valueStart = -1;
  for (let i = afterKey + 1; i < partialArgs.length; i++) {
    if (partialArgs[i] === '"') {
      valueStart = i + 1;
      break;
    }
    if (partialArgs[i] !== ' ' && partialArgs[i] !== '\n' && partialArgs[i] !== '\r' && partialArgs[i] !== '\t') {
      return null;
    }
  }
  if (valueStart === -1) return null;

  const innerJson = unescapeJsonString(partialArgs, valueStart);

  // Phase 2: Find complete top-level objects in the inner JSON array using clarinet.
  return extractTopLevelArrayItems(innerJson);
}

/**
 * Unescape a JSON string starting at the given position.
 * Handles all standard JSON escape sequences.
 * Stops at an unescaped `"` (end of string) or end of input (partial string).
 */
function unescapeJsonString(str: string, startIdx: number): string {
  let result = "";
  let i = startIdx;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') {
      if (i + 1 >= str.length) break;
      const next = str[i + 1];
      switch (next) {
        case '"': result += '"'; i += 2; break;
        case '\\': result += '\\'; i += 2; break;
        case '/': result += '/'; i += 2; break;
        case 'n': result += '\n'; i += 2; break;
        case 'r': result += '\r'; i += 2; break;
        case 't': result += '\t'; i += 2; break;
        case 'b': result += '\b'; i += 2; break;
        case 'f': result += '\f'; i += 2; break;
        case 'u': {
          if (i + 5 < str.length) {
            const hex = str.substring(i + 2, i + 6);
            result += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            return result;
          }
          break;
        }
        default:
          result += next;
          i += 2;
          break;
      }
    } else if (ch === '"') {
      break;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

/**
 * Parse a partial JSON array string and return all complete top-level objects.
 * Uses clarinet for structural parsing.
 */
function extractTopLevelArrayItems(innerJson: string): Array<Record<string, unknown>> | null {
  const bracketStart = innerJson.indexOf("[");
  if (bracketStart === -1) return null;

  const substr = innerJson.substring(bracketStart);
  const parser = clarinet.parser() as CParserWithError;
  let objectDepth = 0;
  let arrayDepth = 0;
  let lastCompleteEnd = -1;

  parser.onerror = () => {
    parser.error = null;
  };

  parser.onopenarray = () => {
    arrayDepth++;
  };

  parser.onclosearray = () => {
    arrayDepth--;
  };

  parser.onopenobject = () => {
    objectDepth++;
  };

  parser.oncloseobject = () => {
    if (objectDepth === 1 && arrayDepth === 1) {
      lastCompleteEnd = parser.position;
    }
    objectDepth--;
  };

  try {
    parser.write(substr);
  } catch {
    // partial JSON
  }

  if (lastCompleteEnd === -1) return null;

  const arrayStr = substr.substring(0, lastCompleteEnd) + "]";
  try {
    return JSON.parse(arrayStr) as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}
