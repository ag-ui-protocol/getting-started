import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether `moduleUrl` is the module the process was started with.
 *
 * Compared by real path rather than `path.resolve`: Node's ESM loader
 * canonicalises module URLs, while `process.argv[1]` keeps whatever symlinks the
 * caller typed. So a checkout reached through one — `~/src` linked to a volume,
 * a symlinked `examples/`, or `tsx /tmp/ag-ui/.../server.ts` where `/tmp` is
 * itself a link — would never match, and the script would exit 0 having printed
 * nothing at all: the worst possible answer to "did my server start?".
 */
export const isEntry = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // A deleted or unreadable entry path is not this module.
    return false;
  }
};
