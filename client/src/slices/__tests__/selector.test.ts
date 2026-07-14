import { store } from "@davstack/store";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSelector, id } from "../selector";

type Trace = { key: string; events: number[] };

type Item = {
  key: string;
  name?: string;
  count?: number;
  source?: { trace?: Trace; step?: number };
};

const items: Item[] = [
  { key: "a", name: "A", count: 1 },
  { key: "b", name: "B", count: 2 },
];

function setup(initial: Item[] = items) {
  const items$ = store<Item[]>(structuredClone(initial));
  return { items$, one: createSelector(items$) };
}

describe("createSelector: set", () => {
  it("keeps a draft mutation made by a transaction that returns nothing", () => {
    const { items$, one } = setup();

    one("a").set((l) => void (l.name = "renamed"));

    expect(items$.get()).toEqual([
      { key: "a", name: "renamed", count: 1 },
      { key: "b", name: "B", count: 2 },
    ]);
  });

  it("keeps the previous value when a transaction returns undefined", () => {
    const { items$, one } = setup();
    const before = items$.get();

    one("a").set(() => undefined);

    // Without the `?? s[i]` fallback the item would be clobbered with undefined.
    expect(items$.get()).toBe(before);
    expect(items$.get()[0]).toEqual({ key: "a", name: "A", count: 1 });
  });

  it("replaces the item with whatever a transaction returns", () => {
    const { items$, one } = setup();

    one("a").set((l) => ({ key: l.key, name: "next" }));

    expect(items$.get()[0]).toEqual({ key: "a", name: "next" });
  });

  it("replaces the item wholesale when handed a value", () => {
    const { items$, one } = setup();

    one("a").set({ key: "a" });

    // A value setter is a replace, not a merge: `name` and `count` are gone.
    expect(items$.get()[0]).toEqual({ key: "a" });
    expect(items$.get()[1]).toEqual({ key: "b", name: "B", count: 2 });
  });

  it("ignores a write to an unknown key", () => {
    const { items$, one } = setup();
    const before = items$.get();
    const transaction = vi.fn((l: Item) => l);

    one("zzz").set(transaction);
    one("zzz").set({ key: "zzz", name: "Z" });

    expect(transaction).not.toHaveBeenCalled();
    expect(items$.get()).toBe(before);
    expect(items$.get()).toHaveLength(2);
  });

  it("matches nothing when no key is given", () => {
    const { items$, one } = setup();
    const before = items$.get();

    one().set({ key: "a", name: "clobbered" });

    expect(items$.get()).toBe(before);
    expect(one().get()).toBeUndefined();
  });
});

describe("createSelector: get", () => {
  it("projects the item through the selector", () => {
    const { one } = setup();
    expect(one("b").get((l) => l.name)).toBe("B");
    expect(one("b").get((l) => l.count! * 10)).toBe(20);
  });

  it("returns the whole item when given no selector", () => {
    const { one } = setup();
    expect(one("a").get()).toEqual({ key: "a", name: "A", count: 1 });
  });

  it("returns undefined for an unknown key, without running the selector", () => {
    const { one } = setup();
    const selector = vi.fn((l: Item) => l.name);

    expect(one("zzz").get(selector)).toBeUndefined();
    expect(selector).not.toHaveBeenCalled();
  });

  it("is a live view of the store, not a snapshot", () => {
    const { one } = setup();
    const api = one("a");

    expect(api.get((l) => l.name)).toBe("A");
    api.set((l) => void (l.name = "renamed"));

    expect(api.get((l) => l.name)).toBe("renamed");
  });
});

describe("createSelector: use", () => {
  it("projects the item and re-renders when the projection changes", () => {
    const { one } = setup();

    const { result } = renderHook(() => one("a").use((l) => l.name));
    expect(result.current).toBe("A");

    act(() => one("a").set((l) => void (l.name = "renamed")));
    expect(result.current).toBe("renamed");
  });

  it("returns undefined until the item exists", () => {
    const { items$, one } = setup();

    const { result } = renderHook(() => one("c").use());
    expect(result.current).toBeUndefined();

    act(() => items$.set((s) => void s.push({ key: "c", name: "C" })));
    expect(result.current).toEqual({ key: "c", name: "C" });
  });

  it("compares projections deeply by default", () => {
    const { one } = setup();
    const render = vi.fn();

    // A fresh object every call: only a deep comparison can hold it stable.
    const { result } = renderHook(() => {
      render();
      return one("a").use((l) => ({ name: l.name }));
    });
    expect(render).toHaveBeenCalledOnce();

    act(() => one("b").set((l) => void (l.name = "renamed")));
    expect(render).toHaveBeenCalledOnce();
    expect(result.current).toEqual({ name: "A" });

    act(() => one("a").set((l) => void (l.name = "renamed")));
    expect(render).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ name: "renamed" });
  });

  it("honours a custom equality checker", () => {
    const { one } = setup();

    const { result } = renderHook(() =>
      one("a").use(
        (l) => l.name,
        () => true,
      ),
    );
    expect(result.current).toBe("A");

    act(() => one("a").set((l) => void (l.name = "renamed")));

    // The checker calls every pair equal, so the hook never sees the new value.
    expect(result.current).toBe("A");
    expect(one("a").get((l) => l.name)).toBe("renamed");
  });
});

describe("id", () => {
  const a: Item = { key: "a", name: "A", count: 1 };

  it("compares two items by a key", () => {
    const byKey = id<Item>("key");
    expect(byKey(a, { key: "a", name: "different", count: 99 })).toBe(true);
    expect(byKey(a, { key: "b", name: "A", count: 1 })).toBe(false);
  });

  it("compares by a derived value", () => {
    const byName = id<Item, string | undefined>((l) => l.name);
    expect(byName(a, { key: "z", name: "A" })).toBe(true);
    expect(byName(a, { key: "a", name: "B" })).toBe(false);
  });

  it("compares the keyed value with a custom comparator", () => {
    const caseless = id<Item, string | undefined>(
      "name",
      (x, y) => x?.toLowerCase() === y?.toLowerCase(),
    );
    expect(caseless(a, { key: "z", name: "a" })).toBe(true);
    expect(caseless(a, { key: "a", name: "B" })).toBe(false);
  });

  it("treats two absent items as equal", () => {
    const byKey = id<Item | undefined>("key");
    expect(byKey(undefined, undefined)).toBe(true);
    expect(byKey(a, undefined)).toBe(false);
  });

  it("holds a projection stable across changes it does not key on", () => {
    const trace: Trace = { key: "t1", events: [1] };
    const { one } = setup([{ key: "a", source: { trace, step: 0 } }]);
    const render = vi.fn();

    const { result } = renderHook(() => {
      render();
      // R must be given explicitly: inferring it from `eq` alone would fix it to
      // `Trace`, which the selector's `Trace | undefined` does not satisfy.
      return one("a").use<Trace | undefined>((l) => l.source?.trace, id<Trace | undefined>("key"));
    });
    expect(result.current).toEqual(trace);
    expect(render).toHaveBeenCalledOnce();

    // Same trace key, different contents: keyed as identical, so no re-render.
    act(() => one("a").set((l) => void (l.source!.trace = { key: "t1", events: [1, 2] })));
    expect(render).toHaveBeenCalledOnce();
    expect(result.current).toEqual({ key: "t1", events: [1] });

    act(() => one("a").set((l) => void (l.source!.trace = { key: "t2", events: [3] })));
    expect(render).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ key: "t2", events: [3] });
  });
});
