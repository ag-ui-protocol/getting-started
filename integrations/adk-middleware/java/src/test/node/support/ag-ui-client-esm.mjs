import { register } from "node:module";

register(new URL("./fast-json-patch-loader.mjs", import.meta.url), import.meta.url);

export const { HttpAgent } = await import("@ag-ui/client");
