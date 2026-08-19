import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared flat config for the TypeScript SDK packages under `sdks/typescript/packages`.
 *
 * Each package re-exports this from its own `eslint.config.mjs`, which makes the
 * `ignores` patterns below resolve relative to that package's directory.
 *
 * Deliberately uses the non-type-checked `recommended` preset: it needs no
 * `project` wiring, so `lint` stays independent of build state and runs in
 * roughly a second per package.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "**/generated/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Honour the leading-underscore convention the SDK already uses (`_`,
      // `_init`) for bindings that must exist but go unread — positional
      // parameters satisfying an interface, discarded destructuring targets and
      // ignored catch bindings. The rule stays an error; this only teaches it
      // the marker the code was already written against.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          // `const { omitted, ...rest } = x` is how the SDK drops a key; the
          // named sibling is the mechanism, not an oversight.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // `no-explicit-any` is off for tests, and only for tests. This is a policy
    // choice, not a way to reach green: every `any` in shipped source was either
    // removed or annotated with a reason, and this exemption cannot hide one,
    // because it does not apply outside these files.
    //
    // Tests deliberately build partial and invalid values to drive edge paths —
    // `{} as any` for a stub agent, `vi.spyOn(agent as any, "run")` to reach a
    // protected member. Rewriting those as `as unknown as AbstractAgent` is no
    // sounder; it just claims completeness the stub does not have.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
