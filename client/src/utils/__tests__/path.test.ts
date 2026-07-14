import { describe, expect, it } from "vitest";
import { ext, name } from "../path";

describe("ext", () => {
  it("returns the segment after the last dot", () => {
    expect(ext("trace.json")).toBe("json");
    expect(ext("map.grid")).toBe("grid");
  });

  it("returns only the last extension of a double-barrelled one", () => {
    expect(ext("archive.tar.gz")).toBe("gz");
  });

  it("returns the WHOLE string when there is no dot", () => {
    // Format detection (`find(accept, { id: ext(f.name) })`) relies on this:
    // an extensionless name is treated as if it were bare format id, not "".
    expect(ext("noext")).toBe("noext");
    expect(ext("json")).toBe("json");
  });

  it("does not normalise case", () => {
    // Format ids are matched case-sensitively downstream, so ext() must not
    // quietly lowercase.
    expect(ext("MAP.XY")).toBe("XY");
  });

  it("returns an empty string for a trailing dot or an empty input", () => {
    expect(ext("trailing.")).toBe("");
    expect(ext("")).toBe("");
  });
});

describe("name", () => {
  it("returns the segment before the first dot", () => {
    expect(name("trace.json")).toBe("trace");
  });

  it("keeps only the first segment of a multi-dot name", () => {
    // Not "archive.tar": everything from the first dot on is dropped, so a
    // dotted stem loses its middle parts in the derived layer name.
    expect(name("archive.tar.gz")).toBe("archive");
    expect(name("map.v2.grid")).toBe("map");
  });

  it("returns the WHOLE string when there is no dot", () => {
    expect(name("noext")).toBe("noext");
  });

  it("returns an empty string for an empty input", () => {
    expect(name("")).toBe("");
  });

  it("is the complement of ext() for a single-dot name", () => {
    expect(`${name("trace.json")}.${ext("trace.json")}`).toBe("trace.json");
  });
});
