// Small, security-minded lint config. Exact-pinned deps: eslint, @eslint/js, typescript-eslint, eslint-plugin-security.
import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", ".agents/**", ".secrets/**", "eslint.config.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Money/signing flows must never drop a promise or hand an async fn to a sync callback.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-throw-literal": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Disabled: flags every `obj[key]` including array indexing; it is a known false-positive generator.
      // Prototype pollution is covered instead by redactValue (drops __proto__) and by validating keys against enums.
      "security/detect-object-injection": "off",
      // Disabled: every fs path in this repo is built from fixed ROOT/.secrets constants; user input (CLI flags, env)
      // never reaches a path (run ids are UUID-validated, --to is an enum). Revisit when web/API code takes paths.
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // Data access boundary (AZ-5, IN-1): the pg driver and SQL text live only in packages/database.
    files: ["**/*.ts", "**/*.mts"],
    ignores: ["packages/database/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "pg", message: "Use @flow-ai/database; SQL and the pg driver live only in packages/database." }, { name: "pg-pool", message: "Use @flow-ai/database." }], patterns: ["pg/*"] }],
      "no-restricted-syntax": [
        "error",
        { selector: "Literal[value=/\\b(SELECT\\s[\\s\\S]+\\sFROM|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM)\\b/i]", message: "SQL text is only allowed inside packages/database." },
        { selector: "TemplateElement[value.raw=/\\b(SELECT\\s[\\s\\S]+\\sFROM|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM)\\b/i]", message: "SQL text is only allowed inside packages/database." },
      ],
    },
  },
  {
    // Test doubles implement async interfaces without awaiting, and tests index loosely typed JSON fixtures.
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
);
