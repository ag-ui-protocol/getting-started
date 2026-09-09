/**
 * Rewrites `workspace:` dependency ranges in a scaffolded project's
 * package.json source to published versions. Pure (string in, string out) so
 * the rewrite and its failure modes are unit tested without a filesystem.
 */
export interface WorkspaceRewrite {
  /** Serialized package.json (2-space indent, trailing newline). */
  content: string;
  /** Dependency name → new range, for every rewritten entry. */
  updated: Record<string, string>;
}

export function rewriteWorkspaceDependencies(
  source: string,
  versions: Record<string, string>,
  requiredPackages: readonly string[] = [],
): WorkspaceRewrite {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(source);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error}`);
  }
  if (packageJson === null || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error("package.json must contain a JSON object.");
  }

  const dependencies = (packageJson as { dependencies?: unknown }).dependencies;
  const deps =
    dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)
      ? (dependencies as Record<string, unknown>)
      : {};

  const updated: Record<string, string> = {};
  for (const [depName, depVersion] of Object.entries(deps)) {
    if (
      typeof depVersion === "string" &&
      depVersion.startsWith("workspace:") &&
      versions[depName]
    ) {
      const version = versions[depName];
      const range = version === "latest" ? version : `^${version}`;
      deps[depName] = range;
      updated[depName] = range;
    }
  }

  for (const requiredPackage of requiredPackages) {
    const range = deps[requiredPackage];
    if (typeof range !== "string") {
      throw new Error(`package.json is missing the required dependency ${requiredPackage}.`);
    }
    if (range.startsWith("workspace:")) {
      throw new Error(
        `Could not resolve a published version for ${requiredPackage}; it is still on "${range}".`,
      );
    }
    if (range === "latest") {
      throw new Error(
        `Could not resolve a concrete published version for ${requiredPackage}; the registry lookup fell back to "latest".`,
      );
    }
  }

  return {
    content: JSON.stringify(packageJson, null, 2) + "\n",
    updated,
  };
}
