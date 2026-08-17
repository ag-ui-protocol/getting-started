import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import next from "eslint-config-next";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  ...next,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // The `scripts/` helpers are CommonJS executables run directly via their
    // shebang, and this package has no `"type": "module"`, so `require()` is
    // the correct idiom for them rather than something to migrate away from.
    files: ["scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
