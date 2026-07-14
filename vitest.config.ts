import { defineConfig } from "vitest/config";

// One runner for the whole workspace: `bun run test` from the repo root covers
// every package. Each project keeps its own config (they need different
// environments and setup files); this only composes them.
export default defineConfig({
  test: {
    projects: [
      "client",
      "internal-renderers",
      "adapter-iron-harvest",
    ],
  },
});
