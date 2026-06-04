import tsParser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import { defineConfig } from "eslint/config";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
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
        activeWindow: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "eslint-comments": eslintComments,
    },
    rules: {
      // Keep the existing convention: allow intentionally-unused args prefixed with `_`
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "all", argsIgnorePattern: "^_" },
      ],

      // Disallow `async` functions with no `await`.
      "@typescript-eslint/require-await": "error",

      // Enforce discipline around ESLint directive comments.
      "eslint-comments/no-unlimited-disable": "error",
      "eslint-comments/require-description": [
        "error",
        {
          // Avoid noise for the matching `eslint-enable` when we use disable/enable blocks.
          ignore: ["eslint-enable"],
        },
      ],
      "eslint-comments/no-restricted-disable": [
        "error",
        // Don't allow disabling Obsidian-specific rules wholesale.
        "obsidianmd/**",
        // ...but allow disabling this one if needed (copy/paste UI strings often need exceptions).
        "!obsidianmd/ui/sentence-case",
        // Don't allow disabling important safety / correctness rules.
        "no-console",
        "no-restricted-globals",
        "no-restricted-imports",
        "no-alert",
        "@typescript-eslint/no-deprecated",
        "@typescript-eslint/no-explicit-any",
        "@microsoft/sdl/no-document-write",
        "@microsoft/sdl/no-eval",
        "@microsoft/sdl/no-inner-html",
        "import/no-nodejs-modules",
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
      // "obsidianmd/no-tfile-tfolder-cast": "off",
    },
  },
]);
