import { v4 as uuidv4 } from 'uuid';

export const structuredClone_ = (obj: any) => {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (err) {
    return { ...obj };
  }
};

/**
 * Generate a random UUID v4
 * Cross-platform compatible (Node.js, browsers, React Native)
 */
export function randomUUID(): string {
  return uuidv4();
}
