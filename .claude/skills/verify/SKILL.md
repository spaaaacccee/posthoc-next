---
name: verify
description: Drive the Posthoc web app in a real browser to observe a change working — load a trace, scrub the playhead, measure memory. Use when verifying renderer, viewport, layer, or playback changes.
---

# Verifying Posthoc

The app is a React SPA (`client/`) plus an Electron shell. For anything touching
the renderer, layers, or playback, the surface is **pixels in a browser** — drive
it with Playwright.

## Launch

```bash
cd client && bun start      # vite --host; picks 5174 if 5173 is taken — check the log
```

The dev server sets `Cross-Origin-Embedder-Policy` / `Cross-Origin-Opener-Policy`
(see the `configure-response-headers` plugin in `client/vite.config.ts`), so
`crossOriginIsolated === true` and the `SharedArrayBuffer` path is live. If it
ever reads false, the store/index code silently falls back to `ArrayBuffer` and
you are not testing the real path.

## Browser

Playwright isn't a repo dep. Install into a scratch dir:

```bash
bunx playwright install chromium     # NOT --with-deps; that needs sudo and fails
cd <scratchdir> && bun add playwright
```

## Driving it — the load sequence

Getting a trace on screen takes four steps, and skipping any leaves you looking
at an empty viewport:

1. `page.goto("http://localhost:5174/")` — the **Explore Posthoc** modal opens on
   start-up with bundled examples. "A* Grid Search - Heat Map" is a good target:
   ~2580 steps, two layers (a `Map` + a `Trace`), so it exercises the multi-layer
   composite path rather than the single-layer fast path.
2. Click its **Open** button (`page.locator("button", { hasText: "Open" })`).
   This *reloads the page* into the workspace — budget 30-60s.
3. Click **"Trust this time"**. The viewport is gated behind a workspace-trust
   prompt; without this the canvas never mounts.
4. Wait for a `<canvas>` with `width > 300`.

## Driving playback

`Playback.tsx` renders `IconButtonWithTooltip label="step-forward"`, but the label
becomes a *Tooltip title*, **not** an `aria-label` — there is no accessible name to
select by. Find the transport row geometrically instead: it's the only row of 5
icon-only buttons, ordered by x as
`[previous-breakpoint, step-backward, play, step-forward, next-breakpoint]`.

Clicking through these kicks off continuous playback, which drives `setStep` far
harder than discrete clicks would — good for renderer stress, but don't assume one
click == one step.

The current step reads out of `document.body.innerText.split("\n")[9]`.

## Measuring memory

`performance.memory` is bucketed to 100KB and **cached for ~20 minutes** in
headless Chrome, so every reading comes back byte-identical and you'll think
nothing changed. Launch with:

```js
chromium.launch({ args: ["--enable-precise-memory-info"] })
```

Force a GC before each reading via CDP (`HeapProfiler.collectGarbage`), otherwise
you're measuring collection timing, not retention.

For "does this leak?" questions, A/B against the unpatched code — `git stash` your
changes, let Vite HMR reload, re-run the identical script. A single absolute number
proves nothing; the *shape* over time does (monotonic climb vs. oscillation).

## Gotchas

- **`bun run typecheck` is broken** (`tsgo` not installed). Use `bunx tsc --noEmit`
  from `client/`, and expect ~2 pre-existing errors in `D2RendererV2.ts` —
  the build doesn't typecheck, so they're latent.
- **Don't run `oxfmt` from `internal-renderers/`** — there's no config there, so it
  reformats the whole directory with defaults and buries your diff in noise. The
  `format` script only covers `client/`.
- `applyScope.test.ts` has 2 pre-existing failures in `client`.
