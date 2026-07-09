import { SegmentOutlined } from "@mui-symbols-material/w300";
import { Stack, SxProps, Theme, useTheme } from "@mui/material";
import { Playback } from "components/app-bar/Playback";
import { Block } from "components/generic/Block";
import { LazyList as List, LazyListHandle as ListHandle } from "components/generic/LazyList";
import { Placeholder } from "components/inspector/Placeholder";
import { useViewTreeContext } from "components/inspector/ViewTree";
import { flattenSubtree } from "hooks/useHighlight";
import { computed } from "hooks/usePlaybackState";
import { inferLayerName } from "layers/inferLayerName";
import { getController } from "layers/layerControllers";
import { isEqual, isUndefined } from "es-toolkit";
import { useEffect, useMemo, useRef, useState } from "react";
import { slice } from "slices";
import { WithLayer } from "slices/layers";
import { id } from "slices/selector";
import { useAcrylic, usePaper } from "theme";
import { SYMBOL_HIGHLIGHTED } from ".";
import { lerp } from "utils/lerp";
import { description } from "./description";
import { ITEM_HEIGHT, PADDING_TOP, pxToInt } from "./constants";
import { StepsLayer } from "./StepsLayer";
import { StepsPageState } from "./StepsPageState";
import { Item } from "./Item";
import { getStreamBuffers } from "layers/trace/traceStreamStore";
import { result } from "utils/result";
import { useOne } from "slices/useOne";

export function PageContent({ layer: key }: { layer?: string }) {
  const { spacing } = useTheme();
  const paper = usePaper();
  const acrylic = useAcrylic();
  const ref = useRef<ListHandle | null>(null);
  const [ready, setReady] = useState(false);

  // Space reserved above the first row for the floating Playback bar / type
  // filter. Previously baked into row 0's height; now owned by the list.
  const headerHeight = pxToInt(spacing(6 + PADDING_TOP));

  // Avoid a destructuring default (`state: {...} = {}`) here: it makes
  // babel-plugin-react-compiler bail out of optimizing this whole component.
  const { isViewTree, state } = useViewTreeContext<StepsPageState>();
  const { selectedType: _selectedType, showHighlighting } = state ?? {};

  const one = slice.layers.one<StepsLayer>(key);

  const step = useOne(one, computed("step"));
  const playing = useOne(one, computed("playing"));

  // Streaming state: dim rows whose frame hasn't been generated yet, like a
  // video editor showing which frames are rendered. Re-reads on `version`.
  const streamKey = useOne(one, (c) => (c as any)?.source?.parsedTrace?.stream?.streamKey);
  const streamVersion = useOne(one, (c) => (c as any)?.source?.parsedTrace?.stream?.version ?? -1);
  const streamComplete = useOne(
    one,
    (c) => (c as any)?.source?.parsedTrace?.stream?.complete ?? false,
  );
  const isUngenerated = useMemo(() => {
    const buffers = getStreamBuffers(streamKey);
    if (!buffers || streamComplete) return () => false;
    return (eventIndex: number) => !buffers.generated[eventIndex];
    // streamVersion drives recomputation as frames stream in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey, streamVersion, streamComplete]);

  const { steps: rawSteps } = useOne(one, (c) => getController(c)?.steps?.(c), id("key")) ?? {};

  // TODO: low performance `isEqual`
  const highlighting = useOne(one, (c) => c?.source?.highlighting, isEqual);
  const isHighlighting = _selectedType === SYMBOL_HIGHLIGHTED;

  const { steps, stepToFilteredStep, isDisabled } = useMemo(
    () =>
      result(() => {
        if (rawSteps) {
          const steps = rawSteps.map((a, b) => [a, b] as const);
          // Distinct event types (single pass) for the type filter. Avoids the
          // prior map->filter->uniq chain over every event.
          const stepTypes = new Set<string>();
          for (const e of rawSteps) if (e?.type) stepTypes.add(e.type);

          const allSelected = !stepTypes.has(_selectedType);

          const path = highlighting?.path;

          const highlighted = path ? (path instanceof Array ? path : flattenSubtree(path)) : [];

          const highlightedSet = new Set(highlighted);

          // `steps` is ordered by step index and `filter` preserves order, so the
          // result is already sorted — no `sortBy` (it was an O(n log n) + full
          // copy over every event, the main cause of the Events-panel freeze on
          // large traces).
          const filtered = showHighlighting
            ? steps.filter(([, step]) => highlightedSet.has(step))
            : allSelected
              ? steps
              : steps.filter(([a]) => a.type === _selectedType);

          // Map an original step to its row in `filtered` lazily via binary search
          // (filtered is sorted by step) instead of precomputing an O(events) map.
          const stepToFilteredStep =
            filtered === steps
              ? (i: number) => i
              : (i: number) => {
                  let lo = 0;
                  let hi = filtered.length;
                  while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (filtered[mid]![1] >= i) hi = mid;
                    else lo = mid + 1;
                  }
                  return lo;
                };

          return {
            steps: filtered,
            stepToFilteredStep,
            isDisabled: (i: number) => (isHighlighting ? !highlightedSet.has(i) : false),
          };
        }
        return {};
      }).result ?? {},
    [rawSteps, _selectedType, highlighting, showHighlighting, isHighlighting],
  );

  useEffect(() => {
    if (!stepToFilteredStep || !ready || !ref.current) return;
    const i = stepToFilteredStep(step!);
    if (playing) {
      let cancelled = false;
      const target = headerHeight + i * ITEM_HEIGHT;
      const f = (timestamp: DOMHighResTimeStamp) => {
        if (cancelled || isUndefined(step) || !ref.current) return;
        const scrollTop = ref.current.getScrollTop();
        ref.current.scrollTo({
          top: lerp(scrollTop, target, 0.000001 * timestamp),
        });
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
      return () => {
        cancelled = true;
      };
    }
    ref.current.scrollToIndex({
      index: i,
      behavior: "smooth",
      offset: -pxToInt(spacing(12 + PADDING_TOP)),
    });
  }, [step, ready, stepToFilteredStep, playing, spacing, headerHeight]);

  return (
    <>
      <Block vertical sx={{ alignItems: "center" }}>
        {steps ? (
          steps.length ? (
            <List
              sx={{ width: "100%", height: "100%" }}
              count={steps.length}
              itemHeight={ITEM_HEIGHT}
              headerHeight={headerHeight}
              handleRef={ref}
              onReady={() => setReady(true)}
              renderItem={(i) => (
                <Item
                  disabled={isDisabled(i) || isUngenerated(steps[i][1])}
                  index={i}
                  event={steps[i][1]}
                  layer={key}
                />
              )}
            />
          ) : (
            <Placeholder
              icon={<SegmentOutlined />}
              label="Events"
              secondary={<WithLayer key={key}>{(l) => description(inferLayerName(l))}</WithLayer>}
            />
          )
        ) : (
          <Placeholder icon={<SegmentOutlined />} label="Events" secondary={description()} />
        )}
      </Block>
      {!!steps?.length && (
        <Stack
          direction="row"
          sx={
            {
              ...acrylic,
              ...paper(1),
              alignItems: "center",
              position: "absolute",
              top: (t) => t.spacing(isViewTree ? 6 : 6 + 7),
              height: (t) => t.spacing(6),
              borderRadius: 1,
              px: 1,
              m: 1,
            } as SxProps<Theme>
          }
        >
          <Playback layer={key} />
        </Stack>
      )}
    </>
  );
}
