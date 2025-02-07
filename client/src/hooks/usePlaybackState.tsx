import { PlaybackLayerData } from "components/app-bar/Playback";
import { useSnackbar } from "components/generic/Snackbar";
import { clamp, isEmpty, min, range, set, trimEnd } from "lodash";
import { produce } from "produce";
import { useEffect, useMemo } from "react";
import { useLayer } from "slices/layers";
import { useBreakPoints2 } from "./useBreakPoints2";

function cancellable<T = void>(f: () => Promise<T>, g: (result: T) => void) {
  let cancelled = false;
  requestAnimationFrame(async () => {
    const result = await f();
    if (!cancelled) g(result);
  });
  return () => {
    cancelled = true;
  };
}

export function usePlaybackState(key?: string) {
  const { layer, setLayer, setKey } = useLayer<PlaybackLayerData>(key);
  const notify = useSnackbar();
  const { shouldBreak } = useBreakPoints2(key);

  useEffect(() => {
    if (key) setKey(key);
  }, [key]);

  const { playback, playbackTo, step: _step = 0 } = layer?.source ?? {};

  const step = min([playbackTo, _step]) ?? 0;

  const ready = !!playbackTo;
  const playing = playback === "playing";
  const [start, end] = [0, (playbackTo ?? 1) - 1];

  return useMemo(() => {
    function setPlaybackState(s: Partial<PlaybackLayerData>) {
      setLayer(
        produce(layer, (l) => set(l!, "source", { ...l?.source, ...s }))!
      );
    }
    const state = {
      start,
      end,
      step,
      canPlay: ready && !playing && step < end,
      canPause: ready && playing,
      canStop: ready && step,
      canStepForward: ready && !playing && step < end,
      canStepBackward: ready && !playing && step > 0,
    };

    const pause = (n = 0) => {
      // notify("Playback paused");
      setPlaybackState({ playback: "paused", step: stepBy(n) });
    };

    const tick = (n = 1) =>
      setPlaybackState({ playback: "playing", step: stepBy(n) });

    const stepWithBreakpointCheck = (count: number, offset: number = 0) =>
      cancellable(
        async () => {
          for (const i of range(offset, count)) {
            const r = shouldBreak(step + i);
            if (!isEmpty(r)) return { ...r, offset: i };
          }
          return { result: "", offset: 0, error: undefined };
        },
        ({ result, offset, error }) => {
          if (!error) {
            if (!isEmpty(result)) {
              notify(`Breakpoint hit: ${result}`, `Step ${step + offset}`);
              pause(offset);
            } else tick(count);
          } else {
            notify(`${trimEnd(error, ".")}`, `Step ${step + offset}`);
            pause();
          }
        }
      );

    const findBreakpoint = (direction: 1 | -1 = 1) => {
      let i;
      for (i = step + direction; i <= end && i >= 0; i += direction) {
        if (shouldBreak(i)) break;
      }
      return i;
    };

    const stepBy = (n: number) => clamp(step + n, start, end);

    const callbacks = {
      play: () => {
        // notify("Playback started");
        setPlaybackState({ playback: "playing", step: stepBy(1) });
      },
      pause,
      stepTo: (n = 0) => setPlaybackState({ step: clamp(n, start, end) }),
      stop: () => setPlaybackState({ step: start, playback: "paused" }),
      stepForward: () => setPlaybackState({ step: stepBy(1) }),
      stepBackward: () => setPlaybackState({ step: stepBy(-1) }),
      tick,
      findBreakpoint,
      stepWithBreakpointCheck,
    };

    return {
      playing: playback === "playing",
      ...state,
      ...callbacks,
    };
  }, [end, playback, playing, ready, start, step, setLayer]);
}
