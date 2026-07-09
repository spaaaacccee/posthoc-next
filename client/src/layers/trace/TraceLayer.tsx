import { PlaybackLayerData } from "components/app-bar/Playback";
import { ParseTraceWorkerReturnType } from "components/renderer/parser-v140/ParseTraceSlaveWorker";
import { DebugLayerData } from "hooks/DebugLayerData";
import { Trace } from "protocol/Trace-v140";
import { Layer } from "slices/layers";
import { UploadedTrace } from "slices/UIState";
import { TrustedLayerData } from "../TrustedLayerData";
import { TraceStreamHandle } from "./traceStreamStore";

export type TraceLayerData = {
  trace?: UploadedTrace & { error?: string };
  parsedTrace?: {
    /** Set by the one-shot path (untrusted). */
    components?: ParseTraceWorkerReturnType;
    /** Always v1.4.0 — older traces are upgraded at ingress by `readTrace`. */
    content?: Trace;
    error?: string;
    /** Set by the streaming path (trusted). Mutually exclusive with `components`. */
    stream?: TraceStreamHandle;
  };
  onion?: "off" | "transparent" | "solid";
} & PlaybackLayerData &
  DebugLayerData &
  TrustedLayerData;

export type TraceLayer = Layer<TraceLayerData>;
