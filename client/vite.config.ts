import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import path from "path";
import { comlink } from "vite-plugin-comlink";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  // Anchored to this file, not the cwd, so the root runner can load it.
  root: path.join(import.meta.dirname, "./src"),
  publicDir: mode === "development" ? "public-dev" : "public",
  base: "./",
  build: { outDir: path.join(import.meta.dirname, "./dist") },
  resolve: { tsconfigPaths: true },
  plugins: [
    // Comlink must be one of the first plugins so it can transform worker
    // imports before other plugins touch them.
    comlink(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    {
      name: "configure-response-headers",
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          next();
        });
      },
    },
  ],
  test: {
    name: "client",
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
  worker: {
    plugins: () => [comlink()],
  },
}));
