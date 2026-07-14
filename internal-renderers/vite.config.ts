import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Anchored to this file, not the cwd, so the root runner can load it.
  root: path.join(import.meta.dirname, "./src"),
  resolve: { tsconfigPaths: true },
  test: {
    name: "internal-renderers",
    globals: true,
    // These suites are CPU-bound and the workspace runs three projects at once, so
    // the 5s default is tight enough that a loaded box fails a passing test.
    testTimeout: 20_000,
    server: {
      deps: {
        inline: ["vitest-canvas-mock"],
      },
    },
    setupFiles: path.join(import.meta.dirname, "./src/setupTests.ts"),
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        resources: "usable",
      },
    },
  },
});
