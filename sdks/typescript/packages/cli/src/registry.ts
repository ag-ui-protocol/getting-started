const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Resolves the npm registry to query for published versions. npm, pnpm, and
 * yarn all export the effective registry to child processes as
 * `npm_config_registry`, so `npx create-ag-ui-app` behind a mirror or a
 * Verdaccio instance resolves versions from the same registry that will later
 * serve `npm install`.
 */
export function resolveRegistry(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  const registry = configured?.trim() ? configured.trim() : DEFAULT_REGISTRY;
  return registry.replace(/\/+$/, "");
}

/**
 * Encodes a package name for use as a registry URL path segment. Scoped names
 * keep the leading `@` but encode the scope/name separator (`@scope%2Fname`) —
 * registry.npmjs.org tolerates a raw slash, but self-hosted registries and
 * reverse proxies commonly route `/@scope/name` as two path segments and 404.
 */
export function encodePackageName(packageName: string): string {
  return packageName.startsWith("@")
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);
}

/** Full metadata URL (packument) for a package on the resolved registry. */
export function packageMetadataUrl(
  packageName: string,
  registry: string = resolveRegistry(),
): string {
  return `${registry.replace(/\/+$/, "")}/${encodePackageName(packageName)}`;
}
