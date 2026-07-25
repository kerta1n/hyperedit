import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".bun", "node_modules", "dist", "./worker-configuration.d.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // One concern per file. The 1,000-line tripwire catches drift — if
    // describing what a file does requires the word "and", split it,
    // regardless of line count.
    files: ["**/*.{ts,tsx}", "scripts/**/*.js"],
    rules: {
      "max-lines": ["error", { max: 1000 }],
    },
  },
  {
    // R1 migration ratchet for scripts/server: handler bodies move in verbatim
    // from the JS monolith, so explicit-any and empty-catch survive the move.
    // Tighten per file as zod boundaries land (Phase 3); delete this block
    // when the last verbatim body is typed.
    files: ["scripts/server/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { caughtErrors: "none", argsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Grandfathered oversized files. This list may ONLY shrink: each
    // refactor phase deletes the entries for files it decomposes.
    // Never add entries.
    files: [
      "src/react-app/components/AIPromptPanel.tsx",
      "src/remotion/DynamicAnimation.tsx",
      "src/react-app/pages/Home.tsx",
      "src/react-app/hooks/useProject.ts",
    ],
    rules: {
      "max-lines": "off",
    },
  }
);
