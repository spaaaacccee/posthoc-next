import { useEffect, useRef } from "react";
import { D2Renderer } from "d2-renderer";
import { times } from "es-toolkit/compat";

const { meta, constructor } = D2Renderer;

export function D2RendererComponent({
  resolution = 0,
  threads = 1,
  tileSize = 256,
}: {
  resolution?: number;
  threads?: number;
  tileSize?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) {
      const host = ref.current;
      const r = new constructor();
      // `setup` is async in PIXI v8, and it is what spawns the workers — so nothing
      // may be added or mounted until it settles, or the components would be posted
      // to a worker pool that does not exist yet.
      let disposed = false;
      let mounted = false;
      const ready = r
        .setup({
          tileSubdivision: resolution,
          workerCount: threads,
          tileResolution: {
            width: tileSize,
            height: tileSize,
          },
          screenSize: {
            width: 640,
            height: 480,
          },
        })
        .then(
          () => {
            if (disposed) return;
            addComponents(r);
            host.append(r.getView()!);
            mounted = true;
          },
          (e) => console.error(e)
        );
      return () => {
        disposed = true;
        void ready.then(() => {
          r.destroy();
          if (mounted) host.removeChild(r.getView()!);
        });
      };
    }
  }, [ref.current, resolution, threads, tileSize]);
  return <div ref={ref} />;
}

function addComponents(r: InstanceType<typeof constructor>) {
  return r.add(
        (
          [
            {
              $: "rect",
              x: 0,
              y: 0,
              width: 128,
              height: 128,
              alpha: 1,
              fill: "#ff0000",
              fontSize: 1,
              text: "",
            },
            {
              $: "rect",
              x: 0,
              y: 0,
              width: 16,
              height: 16,
              alpha: 1,
              fill: "#00ff00",
              fontSize: 1,
              text: "",
            },
            {
              $: "rect",
              x: 128 - 16,
              y: 128 - 16,
              width: 32,
              height: 32,
              alpha: 1,
              fill: "#ffff00",
              fontSize: 16,
              text: "",
            },
            {
              $: "rect",
              x: 128 - 32,
              y: 128 - 32,
              width: 8,
              height: 8,
              alpha: 1,
              fill: "#ffff00",
              fontSize: 16,
              text: "",
            },
            {
              $: "rect",
              x: 128 / 2,
              y: 128 / 2,
              width: 16,
              height: 16,
              alpha: 0,
              fill: "#000000",
              fontSize: 16,
              text: "Test",
            },
          ] as const
        ).map((c) => ({ component: c, meta: {} }))
  );
}
