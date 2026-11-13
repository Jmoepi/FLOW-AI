// Small, security-minded lint config. Exact-pinned deps: eslint, @eslint/js, typescript-eslint, eslint-plugin-security.
import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

// Data access boundary (AZ-5, IN-1): the pg driver and SQL text live only in packages/database.
const PG_PATHS = [{ name: "pg", message: "Use @flow-ai/database; SQL and the pg driver live only in packages/database." }, { name: "pg-pool", message: "Use @flow-ai/database." }];
const SQL_SELECTORS = [
  { selector: "Literal[value=/\\b(SELECT\\s[\\s\\S]+\\sFROM|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM)\\b/i]", message: "SQL text is only allowed inside packages/database." },
  { selector: "TemplateElement[value.raw=/\\b(SELECT\\s[\\s\\S]+\\sFROM|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM)\\b/i]", message: "SQL text is only allowed inside packages/database." },
];
export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.next/**", "**/next-env.d.ts", ".agents/**", ".secrets/**", "eslint.config.mjs"] },
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
      "no-restricted-imports": ["error", { paths: PG_PATHS, patterns: ["pg/*"] }],
      "no-restricted-syntax": ["error", ...SQL_SELECTORS],
    },
  },
  {
    // Owner web app (WB-1): never render untrusted data as markup.
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SQL_SELECTORS,
        { selector: "JSXAttribute[name.name=\"dangerouslySetInnerHTML\"]", message: "dangerouslySetInnerHTML is banned; render data as text (WB-1)." },
        { selector: "Property[key.name=\"dangerouslySetInnerHTML\"]", message: "dangerouslySetInnerHTML is banned; render data as text (WB-1)." },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: "Do not assign markup strings; render data as text (WB-1)." },
      ],
    },
  },
  {
    // Client-side code must not reach server-only modules (secrets, database, sessions).
    files: ["apps/web/src/components/**/*.ts", "apps/web/src/components/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { paths: [...PG_PATHS, { name: "server-only", message: "Client components cannot import server-only code." }, { name: "@flow-ai/database", message: "Client components cannot import the database package." }], patterns: ["pg/*", "**/server/**"] }],
    },
  },
  {
    // Agent process (AG-6, 13.1B): no database, ledger, signer or env dumps. Repeats the base SQL selectors (flat config replaces rule options).
    files: ["apps/agent/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...PG_PATHS,
            { name: "@flow-ai/database", message: "The agent has no database access; it talks to the payment guard over HTTP." },
            { name: "@flow-ai/xrpl-adapter", message: "The agent never touches the ledger or a signer." },
            { name: "@flow-ai/policy-engine", message: "The guard is the only decision maker." },
            { name: "xrpl", message: "The agent never touches the ledger or a signer." },
            { name: "dotenv", message: "The agent never loads dotenv; its environment is built by the launcher." },
            { name: "child_process", message: "Spawning is done by the MCP SDK transport only." },
            { name: "node:child_process", message: "Spawning is done by the MCP SDK transport only." },
          ],
          patterns: ["pg/*", "@flow-ai/database/*", "@flow-ai/xrpl-adapter/*", "@flow-ai/policy-engine/*"],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...SQL_SELECTORS,
        { selector: "MemberExpression[object.name=\"process\"][property.name=\"env\"]", message: "Read the environment only in src/config.ts, src/main.ts or src/mcp/server-main.ts." },
      ],
    },
  },
  {
    files: ["apps/agent/src/config.ts", "apps/agent/src/main.ts", "apps/agent/src/mcp/server-main.ts"],
    rules: { "no-restricted-syntax": ["error", ...SQL_SELECTORS] },
  },
  {
    // Test doubles implement async interfaces without awaiting, and tests index loosely typed JSON fixtures.
    files: ["**/test/**/*.ts", "**/test/**/*.tsx"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
);
