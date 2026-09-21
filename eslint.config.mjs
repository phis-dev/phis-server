import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      /*
       * An underscore says the name is there for its shape, not its value: a parameter kept so a stub
       * matches the signature it stands in for, a field named only to be left out of the rest. The
       * code writes both already; typescript-eslint defaults `ignoreRestSiblings` to false and leaves
       * the ignore patterns empty, so without this it warns about the convention it is being told.
       */
      "@typescript-eslint/no-unused-vars": ["warn", {
        ignoreRestSiblings: true,
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    // Installed Add-ons: bundles put there at run time, not source of this checkout.
    "addons/**",
  ]),
]);

export default eslintConfig;
