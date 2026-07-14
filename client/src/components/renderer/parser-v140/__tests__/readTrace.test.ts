import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTrace } from "../readTrace";

const { append } = vi.hoisted(() => ({ append: vi.fn() }));

// `slice.log.append` is the module's only dependency; the real `slices` barrel
// constructs every store in the app.
vi.mock("slices", () => ({ slice: { log: { append } } }));

const lines = () => append.mock.calls.map(([entry]) => entry.content);

beforeEach(() => append.mockClear());

describe("readTrace", () => {
  it("rejects anything that is not an object", () => {
    for (const input of [undefined, null, false, 0, "", "{}", 42]) {
      expect(readTrace(input)).toBeUndefined();
    }
    expect(lines()).toEqual([]);
  });

  it("upgrades a legacy trace and announces the conversion", () => {
    const trace = readTrace({
      version: "1.0.5",
      render: { views: { main: { components: [{ $: "rect", x: "{{ $.event.x }}" }] } } },
    });
    expect(trace?.version).toBe("1.4.0");
    expect(trace?.views?.main).toEqual([{ $: "rect", x: "${{ $.event.x }}" }]);
    expect(lines()).toEqual(["Converted trace from version 1.0.5 to 1.4.0."]);
  });

  it("names an unversioned trace in the conversion line", () => {
    readTrace({ events: [] });
    expect(lines()).toEqual(["Converted trace from version unversioned to 1.4.0."]);
  });

  it("returns the same upgraded object for the same raw object, and logs it once", () => {
    const raw = { version: "1.0.5", render: { views: { main: { components: [] } } } };

    const first = readTrace(raw);
    const second = readTrace(raw);

    expect(first).toBeDefined();
    expect(first).not.toBe(raw);
    expect(second).toBe(first);
    expect(lines()).toEqual(["Converted trace from version 1.0.5 to 1.4.0."]);
  });

  it("caches by identity, not by value", () => {
    const first = readTrace({ version: "1.0.5", render: {} });
    const second = readTrace({ version: "1.0.5", render: {} });

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(lines()).toHaveLength(2);
  });

  it("forwards every conversion warning, once per raw object", () => {
    const raw = {
      version: "1.0.5",
      render: {
        views: {
          main: {
            components: [
              { $: "a", display: "leading text {{ $.event.x }}" },
              { $: "b", display: "{{ $.event.y }} trailing text" },
            ],
          },
        },
      },
    };

    readTrace(raw);
    readTrace(raw);

    expect(lines()).toEqual([
      "Converted trace from version 1.0.5 to 1.4.0.",
      expect.stringContaining("Trace conversion: Could not convert 'display: leading text {{"),
      expect.stringContaining(
        "Trace conversion: Could not convert 'display: {{ $.event.y }} trailing",
      ),
    ]);
  });

  it("freezes the trace it hands out, but only shallowly", () => {
    const events = [{ id: 0 }];
    const trace = readTrace({ version: "1.0.5", render: {}, events });

    expect(Object.isFrozen(trace)).toBe(true);
    // The event array is passed through by reference and left mutable, so that
    // immer's auto-freeze early-returns on the trace instead of walking it.
    expect(trace!.events).toBe(events);
    expect(Object.isFrozen(trace!.events)).toBe(false);
  });

  it("passes a v1.4.0 trace through as-is, freezing the caller's object in place", () => {
    const raw = { version: "1.4.0", views: {}, events: [] };

    const trace = readTrace(raw);

    expect(trace).toBe(raw);
    expect(Object.isFrozen(raw)).toBe(true);
    expect(lines()).toEqual([]);
  });
});
