import { v4 as uuidv4 } from "uuid";

export const structuredClone_ = <T>(obj: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (_err) {
    // Preserve array vs object type in shallow fallback
    if (Array.isArray(obj)) {
      return [...obj] as unknown as T;
    }
    return { ...obj } as T;
  }
};

/**
 * Generate a random UUID v4
 * Cross-platform compatible (Node.js, browsers, React Native)
 */
export function randomUUID(): string {
  return uuidv4();
}

// Note: semver helpers were removed in favor of using
// the external `compare-versions` library directly at call sites.

/**
 * Parses a semantic version string into its numeric components.
 * Supports incomplete versions (e.g. "1", "1.2") by defaulting missing segments to zero.
 *
 * @throws If the version string is not a valid semantic version.
 */
// (Intentionally left minimal.)
