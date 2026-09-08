// @mastra/core ships the runtime for `test-utils/llm-mock` but, as of 1.47.0,
// omits its `.d.ts` (the export map points at a declaration file that isn't in
// the published tarball). Declare the slice the tests use so `tsc --noEmit`
// resolves it. Remove once upstream ships the declarations.
declare module "@mastra/core/test-utils/llm-mock" {
  export class MastraLanguageModelV2Mock {
    constructor(options?: Record<string, any>);
  }
}
