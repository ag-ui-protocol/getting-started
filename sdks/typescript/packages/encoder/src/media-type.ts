/**
 * negotiator
 * Copyright(c) 2012 Isaac Z. Schlueter
 * Copyright(c) 2014 Federico Romero
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

// modified from https://github.com/jshttp/negotiator/blob/master/lib/mediaType.js

/**
 * Module exports.
 * @public
 */

export function preferredMediaTypes(accept?: string, provided?: string[]): string[] {
  // RFC 2616 sec 14.2: no header = */*
  const accepts = parseAccept(accept === undefined ? "*/*" : accept || "");

  if (!provided) {
    // sorted list of all types
    return accepts
      .filter((spec): spec is MediaType => spec.q > 0)
      .sort((a, b) => {
        return b.q - a.q || b.i - a.i || 0;
      })
      .map(getFullType);
  }

  const priorities = provided.map(function getPriority(type: string, index: number) {
    return getMediaTypePriority(type, accepts, index);
  });

  // sorted list of accepted types
  return priorities
    .filter((spec): spec is Priority => spec.q > 0)
    .sort(compareSpecs)
    .map(function getType(priority: Priority) {
      return provided[priorities.indexOf(priority)];
    });
}

/**
 * Module variables.
 * @private
 */

const simpleMediaTypeRegExp = /^\s*([^\s/;]+)\/([^;\s]+)\s*(?:;(.*))?$/;

/**
 * Media type interface
 * @private
 */
interface MediaType {
  type: string;
  subtype: string;
  params: Record<string, string>;
  q: number;
  i: number;
}

/**
 * Priority interface
 * @private
 */
interface Priority {
  o: number;
  q: number;
  s: number;
  i?: number;
}

/**
 * Parse the Accept header.
 * @private
 */
function parseAccept(accept: string): MediaType[] {
  const accepts = splitMediaTypes(accept);
  const result: MediaType[] = [];

  for (let i = 0, j = 0; i < accepts.length; i++) {
    const mediaType = parseMediaType(accepts[i].trim(), i);

    if (mediaType) {
      result[j++] = mediaType;
    }
  }

  return result;
}

/**
 * Parse a media type from the Accept header.
 * @private
 */
function parseMediaType(str: string, i: number): MediaType | null {
  const match = simpleMediaTypeRegExp.exec(str);
  if (!match) return null;

  const params: Record<string, string> = Object.create(null);
  let q = 1;
  const subtype = match[2];
  const type = match[1];

  if (match[3]) {
    const kvps = splitParameters(match[3]).map(splitKeyValuePair);

    for (let j = 0; j < kvps.length; j++) {
      const pair = kvps[j];
      const key = pair[0].toLowerCase();
      const val = pair[1];

      // get the value, unwrapping quotes
      const value = val && val[0] === '"' && val[val.length - 1] === '"' ? val.slice(1, -1) : val;

      if (key === "q") {
        q = parseFloat(value);
        break;
      }

      // store parameter
      params[key] = value;
    }
  }

  return {
    type: type,
    subtype: subtype,
    params: params,
    q: q,
    i: i,
  };
}

/**
 * Get the priority of a media type.
 * @private
 */
function getMediaTypePriority(type: string, accepted: MediaType[], index: number): Priority {
  const priority: Priority = { o: -1, q: 0, s: 0 };

  for (let i = 0; i < accepted.length; i++) {
    const spec = specify(type, accepted[i], index);

    if (spec && (priority.s - spec.s || priority.q - spec.q || priority.o - spec.o) < 0) {
      priority.o = spec.o;
      priority.q = spec.q;
      priority.s = spec.s;
      priority.i = spec.i;
    }
  }

  return priority;
}

/**
 * Get the specificity of the media type.
 * @private
 */
function specify(type: string, spec: MediaType, index: number): Priority | null {
  const p = parseMediaType(type, 0);
  let s = 0;

  if (!p) {
    return null;
  }

  if (spec.type.toLowerCase() == p.type.toLowerCase()) {
    s |= 4;
  } else if (spec.type != "*") {
    return null;
  }

  if (spec.subtype.toLowerCase() == p.subtype.toLowerCase()) {
    s |= 2;
  } else if (spec.subtype != "*") {
    return null;
  }

  const keys = Object.keys(spec.params);
  if (keys.length > 0) {
    if (
      keys.every(function (k) {
        return (
          spec.params[k] == "*" ||
          (spec.params[k] || "").toLowerCase() == (p.params[k] || "").toLowerCase()
        );
      })
    ) {
      s |= 1;
    } else {
      return null;
    }
  }

  return {
    i: index,
    o: spec.i,
    q: spec.q,
    s: s,
  };
}

/**
 * Compare two specs.
 * @private
 */
function compareSpecs(a: Priority, b: Priority): number {
  return b.q - a.q || b.s - a.s || (a.o || 0) - (b.o || 0) || (a.i || 0) - (b.i || 0) || 0;
}

/**
 * Get full type string.
 * @private
 */
function getFullType(spec: MediaType): string {
  return spec.type + "/" + spec.subtype;
}

/**
 * Count the number of quotes in a string.
 * @private
 */
function quoteCount(string: string): number {
  let count = 0;
  let index = 0;

  while ((index = string.indexOf('"', index)) !== -1) {
    count++;
    index++;
  }

  return count;
}

/**
 * Split a key value pair.
 * @private
 */
function splitKeyValuePair(str: string): [string, string] {
  const index = str.indexOf("=");
  let key: string;
  let val: string = "";

  if (index === -1) {
    key = str;
  } else {
    key = str.slice(0, index);
    val = str.slice(index + 1);
  }

  return [key, val];
}

/**
 * Split an Accept header into media types.
 * @private
 */
function splitMediaTypes(accept: string): string[] {
  const accepts = accept.split(",");
  const result: string[] = [accepts[0]];

  for (let i = 1, j = 0; i < accepts.length; i++) {
    if (quoteCount(result[j]) % 2 == 0) {
      result[++j] = accepts[i];
    } else {
      result[j] += "," + accepts[i];
    }
  }

  // trim result
  return result;
}

/**
 * Split a string of parameters.
 * @private
 */
function splitParameters(str: string): string[] {
  const parameters = str.split(";");
  const result: string[] = [parameters[0]];

  for (let i = 1, j = 0; i < parameters.length; i++) {
    if (quoteCount(result[j]) % 2 == 0) {
      result[++j] = parameters[i];
    } else {
      result[j] += ";" + parameters[i];
    }
  }

  // trim parameters
  for (let i = 0; i < result.length; i++) {
    result[i] = result[i].trim();
  }

  return result;
}
