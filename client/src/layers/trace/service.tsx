import { useTheme } from "@mui/material";
import { PlaybackService } from "components/app-bar/Playback";
import { useUntrustedLayers } from "components/inspector/useUntrustedLayers";
import { useTraceParser } from "components/renderer/parser-v140/parseTrace";
import { useTraceContent } from "hooks/useTraceContent";
import { nanoid } from "nanoid";
import { Trace } from "protocol/Trace-v140";
import { withProduce } from "produce";
import { useEffect } from "react";
import { BreakpointService } from "services/BreakpointService";
import { useAllRenderersSupportLoad } from "slices/renderers";
import { set } from "utils/set";
import { Controller } from "./types";
import { useEventContext } from "./useEventContext";
import { useTraceStream } from "./useTraceStream";

export const service = withProduce(({ value, produce }) => {
  const { palette } = useTheme();
  const { result: trace, loading } = useTraceContent(value?.source?.trace);
  // Set playback
  useEffect(() => {
    produce((l) => void set(l, "source.playbackTo", trace?.content?.events?.length ?? 0));
    // `produce` is recreated every render, so it's intentionally omitted to avoid
    // re-running on every render; this reacts to the trace and its event count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace?.key, trace?.content?.events?.length]);
  // A new trace always starts at the first step. Keyed on the trace alone, so a
  // growing event count during streaming doesn't yank playback back to the start.
  useEffect(() => {
    produce((l) => void set(l, "source.step", 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace?.key]);
  const { isTrusted } = useUntrustedLayers();

  const context = useEventContext();

  // v1.4.0 trusted traces stream their components in incrementally; everything
  // else (legacy formats, untrusted layers) uses the one-shot path below.
  const streaming = trace?.content?.version === "1.4.0" && isTrusted;

  // When every mounted renderer drives the shared-store load() path, it builds
  // its own columnar store — so the per-step component fleet is pure waste.
  // `streaming` stays true (which keeps the one-shot parser disabled); only the
  // component generation is skipped.
  const loadCapable = useAllRenderersSupportLoad();

  useTraceStream({
    enabled: streaming,
    componentsEnabled: !loadCapable,
    traceKey: trace?.key,
    content: trace?.content as Trace,
    context,
    view: "main",
    step: value?.source?.step ?? 0,
    produce,
  });

  // One-shot parser (legacy / untrusted only). v1.4.0 trusted traces stream.
  const { data: parsedTrace } = useTraceParser({
    key: trace?.key,
    trace: trace?.content,
    context,
    view: "main",
    trusted: isTrusted,
    contextKey: palette.mode,
    enabled: !loading && !streaming,
  });
  useEffect(() => {
    if (parsedTrace) {
      // One-shot path: `parsedTrace` holds the full `content` plus per-event
      // `components` arrays. Shallow-freeze it so immer's auto-freeze treats it as
      // an opaque leaf (freeze() early-returns on a frozen object) instead of
      // deep-freezing every event/component on commit — the same trick used for
      // `content` on import. This result is committed once and never mutated.
      Object.freeze(parsedTrace);
      produce((l) => {
        set(l, "source.parsedTrace", parsedTrace);
        set(l, "viewKey", nanoid());
      });
    }
    // `produce` is recreated each render, so it's intentionally omitted; this
    // reacts to a fresh parse result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedTrace]);
  return (
    <>
      <PlaybackService value={value} />
      <BreakpointService value={value?.key} />
    </>
  );
}) satisfies Controller["service"];
