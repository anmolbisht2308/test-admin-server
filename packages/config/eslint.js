import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared flat config for Node packages.
 * @param {string} tsconfigRootDir - pass `import.meta.dirname` from the consuming package
 */
export function nodeConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores: ["dist/**", "coverage/**", "*.config.*"] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        globals: globals.node,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        "no-console": "error",
      },
    },
    {
      // supertest types response bodies as `any`; tests assert on them directly.
      files: ["test/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
      },
    },
  );
}
