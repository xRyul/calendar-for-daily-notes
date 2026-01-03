import tsParser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  // Generated / third-party files we never want to lint
  {
    ignores: [
      "**/node_modules/**",
      "main.js",
    ],
  },

  // Obsidian's default lint rules (same set used by Obsidian itself)
  ...obsidianmd.configs.recommended,

  // Project-specific TypeScript settings / overrides
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Keep the existing convention: allow intentionally-unused args prefixed with `_`
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "all", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      // Obsidian runtime classes like TFile don't exist in unit tests; casting is often unavoidable.
      "obsidianmd/no-tfile-tfolder-cast": "off",
    },
  },
]);
