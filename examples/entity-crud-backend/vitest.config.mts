import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    projects: [
      { test: { name: "express5" } },
      {
        // Exercise both the app and the production router with Express 4.
        // It ignores returned promises, so async errors must reach next(error).
        resolve: {
          alias: [
            { find: /^express$/, replacement: require.resolve("express4") },
          ],
        },
        test: {
          name: "express4",
          include: ["src/entity-crud.routes.spec.ts"],
        },
      },
    ],
  },
});
