import type { Layer } from "slices/layers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inferLayerName } from "../inferLayerName";
import type { LayerController } from "../LayerController";
import { getController } from "../layerControllers";

// The real module eagerly pulls in every layer controller (editors, renderers,
// monaco); only the `source.type` -> `inferName` dispatch matters here.
vi.mock("../layerControllers", () => ({ getController: vi.fn() }));

type Source = { id?: string };

const traceInferName = vi.fn((layer: Layer<Source>) => `Trace: ${layer.source?.id}`);
const mapInferName = vi.fn(() => "A map");

const controllers = {
  trace: { inferName: traceInferName },
  map: { inferName: mapInferName },
} as unknown as Record<string, LayerController<string, Source>>;

const traceLayer: Layer<Source> = { key: "a", source: { type: "trace", id: "t1" } };
const mapLayer: Layer<Source> = { key: "b", source: { type: "map", id: "m1" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getController).mockImplementation((layer) =>
    typeof layer === "string" ? controllers[layer] : controllers[layer?.source?.type ?? ""],
  );
});

describe("inferLayerName", () => {
  it("prefers an explicit name over the controller", () => {
    expect(inferLayerName({ ...traceLayer, name: "My Layer" })).toBe("My Layer");
    expect(traceInferName).not.toHaveBeenCalled();
  });

  it("asks the controller for the layer's source type when there is no name", () => {
    expect(inferLayerName(traceLayer)).toBe("Trace: t1");
    expect(inferLayerName(mapLayer)).toBe("A map");
    expect(traceInferName).toHaveBeenCalledTimes(1);
    expect(mapInferName).toHaveBeenCalledTimes(1);
  });

  it("treats an empty name as no name and falls through to the controller", () => {
    expect(inferLayerName({ ...mapLayer, name: "" })).toBe("A map");
  });

  it("falls back to `Untitled Layer` for a layer with no name and no source", () => {
    expect(inferLayerName({ key: "a" })).toBe("Untitled Layer");
    expect(getController).not.toHaveBeenCalled();
  });

  it("falls back to `Untitled Layer` when there is no layer at all", () => {
    expect(inferLayerName()).toBe("Untitled Layer");
    expect(getController).not.toHaveBeenCalled();
  });
});
