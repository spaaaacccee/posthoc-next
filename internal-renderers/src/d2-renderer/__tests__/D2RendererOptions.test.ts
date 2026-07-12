import { defaultD2RendererOptions, nextResolutionScale } from "d2-renderer/D2RendererOptions";
import { describe, expect, it } from "vitest";

const { dynamicResolution: dr } = defaultD2RendererOptions;
const { dtMax, dtMin, maxScale, minScale } = dr;

const SLOW = dtMax + 1; // frames are slow -> render smaller tiles
const FAST = dtMin - 1; // frames are fast -> go back to full resolution
const STEADY = (dtMin + dtMax) / 2; // inside the hysteresis band -> hold

describe("nextResolutionScale", () => {
  it("is binary: only ever full or half resolution", () => {
    // Whatever sequence of frame timings arrives, the scale must land on one of
    // exactly two values. Every distinct scale is a distinct tile size, and every
    // tile size is a separate entry in the workers' size-keyed raster caches — a
    // third, transient size churns those caches for nothing.
    const seen = new Set<number>();
    let scale = minScale;
    for (const adt of [SLOW, SLOW, FAST, STEADY, SLOW, FAST, FAST, STEADY, SLOW]) {
      scale = nextResolutionScale(scale, adt, dr);
      seen.add(scale);
    }
    expect([...seen].sort()).toEqual([minScale, maxScale]);
    expect(maxScale / minScale).toBe(2); // ...and "half" really is half
  });

  it("scales up under load and back down when frames are cheap again", () => {
    expect(nextResolutionScale(minScale, SLOW, dr)).toBe(maxScale);
    expect(nextResolutionScale(maxScale, FAST, dr)).toBe(minScale);
  });

  it("holds inside the hysteresis band, so it can't oscillate every tick", () => {
    expect(nextResolutionScale(minScale, STEADY, dr)).toBe(minScale);
    expect(nextResolutionScale(maxScale, STEADY, dr)).toBe(maxScale);
  });

  it("clamps at both ends rather than running away", () => {
    expect(nextResolutionScale(maxScale, SLOW, dr)).toBe(maxScale);
    expect(nextResolutionScale(minScale, FAST, dr)).toBe(minScale);
  });
});
