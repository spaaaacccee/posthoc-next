import { entries, find, map, startCase } from "lodash-es";
import { _ } from "utils/chain";
import memoizee from "memoizee";
import { Scheme } from "protocol/SolveTask";
import url from "url-parse";
import { Transport } from "./Transport";

const paths = import.meta.glob<boolean, string, string>("/public/maps/*.grid", {
  query: "?url",
  import: "default",
});

function ext(path: string) {
  return path.split(".")[1];
}
function stripExtension(path: string) {
  return path.split(".")[0];
}

function basename(path: string) {
  return path.split("/").pop()!;
}

const getFileInfo = memoizee(
  async (k: string, f: () => Promise<string>) => {
    return {
      id: `basic-maps${k}`,
      name: _(k, basename, stripExtension, startCase),
      path: await f(),
      format: ext(k),
    };
  },
  { normalizer: ([k]) => k }
);

const getFiles = async () =>
  await Promise.all(map(entries(paths), (e) => getFileInfo(...e)));

export function parseURI(uri: string) {
  const { protocol, pathname } = url(uri);
  return {
    scheme: protocol as Scheme,
    content: decodeURIComponent(pathname),
  };
}

export const internal: Record<string, Transport["call"]> = {
  "basic-maps": async (name, params) => {
    switch (name) {
      case "about": {
        return {
          name: "Basic Maps",
          description: "A collection of basic grid maps",
          version: "1.2.2",
        };
      }
      case "features/formats": {
        return [
          {
            id: "grid",
            name: "Grid",
          },
          {
            id: "xy",
            name: "Network",
          },
          {
            id: "mesh",
            name: "Mesh",
          },
        ];
      }
      case "features/maps": {
        return await getFiles();
      }
      case "features/map": {
        const maps = await getFiles();
        const map = find(maps, { id: params?.id });
        if (map) {
          const file = await fetch(map.path);
          return {
            ...map,
            content: await file.text(),
          };
        }
      }
    }
  },
};
