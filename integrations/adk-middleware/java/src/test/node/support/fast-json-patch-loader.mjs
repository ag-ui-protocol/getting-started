const clientPackagePath = "/node_modules/@ag-ui/client/";
const shimUrl = new URL("./fast-json-patch-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "fast-json-patch" && context.parentURL?.includes(clientPackagePath)) {
    return { shortCircuit: true, url: shimUrl };
  }
  return nextResolve(specifier, context);
}
