import { createRequire } from "node:module";

const fastJsonPatch = createRequire(import.meta.url)("fast-json-patch");

export const applyPatch = (...arguments_) => fastJsonPatch.applyPatch(...arguments_);
export default fastJsonPatch;
