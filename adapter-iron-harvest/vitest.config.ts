import { defineConfig } from "vitest/config";

// Kept separate from `vite.config.ts`, which is a build-only config: it targets
// node16 with a CJS SSR bundle, and none of that belongs in a test run.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "adapter-iron-harvest",
    environment: "node",
    // The RPC suite binds a real port, so files must not run concurrently.
    fileParallelism: false,
  },
});
