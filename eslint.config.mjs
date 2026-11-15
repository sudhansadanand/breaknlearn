import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "legacy/**",
      "apps/student/public/**",
      "docs/handoff/**",
      "playwright-report/**",
      "test-results/**",
      "**/next-env.d.ts",
      "apps/admin/public/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    // Static concept prototype and school demo (ES5 browser scripts, no modules).
    files: ["apps/prototype/**/*.js"],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", location: "readonly", navigator: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
      },
    },
    // ES5 has no optional catch binding.
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }] },
  },
  {
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly" } },
  },
);
