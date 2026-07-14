import { Box, BoxProps, useTheme } from "@mui/material";
import { clamp } from "es-toolkit";
import { useOverlayScrollbars } from "overlayscrollbars-react";
import {
  ReactElement,
  ReactNode,
  Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useCss } from "react-use";

// Browsers silently clamp the maximum height of a single element (Chrome
// ~33.5M px, Firefox ~17.9M px, Safari higher). A naive virtual list sizes its
// scroller to `count * itemHeight`; past the clamp the tail becomes unreachable
// and scroll-to-bottom fails. We cap the scroller at a height that is safe on
// every engine and remap scroll position into "virtual" coordinates, so the
// list works for any event count.
const MAX_ELEMENT_HEIGHT = 15_000_000;

export type LazyListHandle = {
  /** Scroll so that virtual offset `top` is at the viewport top. */
  scrollTo: (opts: { top: number; behavior?: ScrollBehavior }) => void;
  /** Scroll so that row `index` is at the viewport top (+ optional `offset`). */
  scrollToIndex: (opts: { index: number; offset?: number; behavior?: ScrollBehavior }) => void;
  /** Current scroll position in virtual coordinates. */
  getScrollTop: () => number;
};

export type LazyListProps = {
  count: number;
  itemHeight: number;
  /** Extra space reserved above the first row (e.g. for a floating header). */
  headerHeight?: number;
  overscan?: number;
  renderItem: (index: number) => ReactNode;
  handleRef?: Ref<LazyListHandle>;
  onReady?: () => void;
} & Omit<BoxProps, "children">;

type Geometry = {
  vpH: number;
  realH: number;
  scrollerH: number;
  maxScroll: number;
  maxVirtual: number;
};

export function LazyList({
  count,
  itemHeight,
  headerHeight: headerHeightProp,
  overscan: overscanProp,
  renderItem,
  handleRef,
  onReady,
  ...props
}: LazyListProps) {
  // Defaults live in the body, not the destructure: an object-destructuring
  // default makes babel-plugin-react-compiler bail out of memoizing the
  // component.
  const headerHeight = headerHeightProp ?? 0;
  const overscan = overscanProp ?? 3;

  const { palette, spacing } = useTheme();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  // Latest layout params, read by the (stable) scroll/resize handler so it
  // never captures stale values.
  const paramsRef = useRef({ count, itemHeight, headerHeight, overscan });
  paramsRef.current = { count, itemHeight, headerHeight, overscan };

  const [{ first, last, scrollerH }, setWindow] = useState({
    first: 0,
    last: 0,
    scrollerH: 0,
  });
  const winRef = useRef({ first: 0, last: 0, scrollerH: 0 });

  const geometry = useCallback((vpH: number): Geometry => {
    const { count: n, itemHeight: h, headerHeight: header } = paramsRef.current;
    const realH = n > 0 ? header + n * h : 0;
    const scrollerH = Math.min(realH, MAX_ELEMENT_HEIGHT);
    return {
      vpH,
      realH,
      scrollerH,
      maxScroll: Math.max(0, scrollerH - vpH),
      maxVirtual: Math.max(0, realH - vpH),
    };
  }, []);

  const toVirtual = useCallback(
    (scrollTop: number, g: Geometry) =>
      g.maxScroll > 0 ? (scrollTop / g.maxScroll) * g.maxVirtual : 0,
    [],
  );
  const toElement = useCallback(
    (virtualTop: number, g: Geometry) =>
      g.maxVirtual > 0 ? (clamp(virtualTop, 0, g.maxVirtual) / g.maxVirtual) * g.maxScroll : 0,
    [],
  );

  const update = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const { count: n, itemHeight: h, headerHeight: header, overscan: ov } = paramsRef.current;
    const g = geometry(vp.clientHeight);
    const vt = toVirtual(vp.scrollTop, g);

    const firstVisible = Math.floor((vt - header) / h);
    const nextFirst = clamp(firstVisible - ov, 0, Math.max(0, n - 1));
    const lastVisible = Math.floor((vt + g.vpH - header) / h);
    const nextLast = clamp(lastVisible + ov, 0, Math.max(0, n - 1));

    // Smooth motion between row shifts: translate the row container by the
    // sub-row remainder imperatively, so visible `Item`s don't re-render every
    // frame — only when the window (first/last) actually changes.
    const base = header + nextFirst * h - vt;
    if (rowsRef.current) {
      rowsRef.current.style.transform = `translateY(${base}px)`;
    }

    const w = winRef.current;
    if (w.first !== nextFirst || w.last !== nextLast || w.scrollerH !== g.scrollerH) {
      winRef.current = {
        first: nextFirst,
        last: nextLast,
        scrollerH: g.scrollerH,
      };
      setWindow(winRef.current);
    }
  }, [geometry, toVirtual]);

  // OverlayScrollbars styling (ported from the previous Virtuoso Scroller).
  const cls = useCss({
    "--os-padding-perpendicular": "2px",
    ".os-scrollbar": { visibility: "visible", opacity: 1 },
    ".os-scrollbar-vertical > .os-scrollbar-track > .os-scrollbar-handle": {
      "min-height": spacing(12),
    },
    "div.os-scrollbar-vertical > div.os-scrollbar-track": {
      height: `calc(100% - ${spacing(6)})`,
      marginTop: spacing(6),
    },
    "div > div.os-scrollbar-track": {
      "--os-handle-perpendicular-size": "2px",
      "--os-handle-perpendicular-size-hover": "6px",
      "--os-handle-perpendicular-size-active": "6px",
      "> div.os-scrollbar-handle": {
        borderRadius: 0,
        opacity: 0.5,
        "&:hover": { opacity: 0.8 },
      },
    },
  });

  const [initialize] = useOverlayScrollbars({
    options: {
      overflow: { x: "hidden", y: "scroll" },
      scrollbars: {
        autoHide: "move",
        theme: palette.mode === "dark" ? "os-theme-light" : "os-theme-dark",
      },
    },
  });

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    const viewport = viewportRef.current;
    if (!container || !viewport) return;
    initialize({ target: container, elements: { viewport } });
    onReadyRef.current?.();
  }, [initialize]);

  // Scroll + resize wiring. The listener is attached once; `update` reads the
  // latest params from refs.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let scheduled = false;
    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        update();
      });
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => update());
    ro.observe(vp);
    return () => {
      vp.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [update]);

  // Recompute the window synchronously whenever the data/layout changes.
  useLayoutEffect(() => {
    update();
  }, [update, count, itemHeight, headerHeight, overscan]);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollTo: ({ top, behavior }) => {
        const vp = viewportRef.current;
        if (!vp) return;
        vp.scrollTo({ top: toElement(top, geometry(vp.clientHeight)), behavior });
      },
      scrollToIndex: ({ index, offset = 0, behavior }) => {
        const vp = viewportRef.current;
        if (!vp) return;
        const { itemHeight: h, headerHeight: header } = paramsRef.current;
        const vt = header + index * h + offset;
        vp.scrollTo({ top: toElement(vt, geometry(vp.clientHeight)), behavior });
      },
      getScrollTop: () => {
        const vp = viewportRef.current;
        return vp ? toVirtual(vp.scrollTop, geometry(vp.clientHeight)) : 0;
      },
    }),
    [geometry, toElement, toVirtual],
  );

  const rows: ReactElement[] = [];
  if (count > 0) {
    for (let i = first; i <= last && i < count; i++) {
      rows.push(
        <div
          key={i}
          style={{
            position: "absolute",
            top: (i - first) * itemHeight,
            left: 0,
            right: 0,
            height: itemHeight,
          }}
        >
          {renderItem(i)}
        </div>,
      );
    }
  }

  return (
    <Box {...props}>
      <div ref={containerRef} className={cls} style={{ height: "100%" }}>
        <div ref={viewportRef} style={{ height: "100%", overflowY: "auto" }}>
          {/* Row container: `sticky` pins it to the viewport top natively, so
              the transform below only carries the sub-row remainder (never the
              full multi-million-px scroll offset). Height 0 — rows are absolute
              children. Must precede the spacer so its sticky origin is y=0. */}
          <div
            ref={rowsRef}
            style={{
              position: "sticky",
              top: 0,
              height: 0,
              zIndex: 1,
              willChange: "transform",
            }}
          >
            {rows}
          </div>
          {/* Spacer: defines the (capped) scroll range. */}
          <div style={{ height: scrollerH, width: "100%", pointerEvents: "none" }} />
        </div>
      </div>
    </Box>
  );
}
