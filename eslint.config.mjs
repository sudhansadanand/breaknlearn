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
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly" } },
  },
);
