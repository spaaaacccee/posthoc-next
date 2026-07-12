import {
  CenterFocusWeakOutlined,
  FiberManualRecordFilledOutlined as FiberManualRecord,
  FlipCameraAndroidOutlined as RotateIcon,
} from "@mui-symbols-material/w300";
import {
  alpha,
  Box,
  Divider,
  Stack,
  SxProps,
  Theme,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { MinimisedPlaybackControls } from "components/app-bar/Playback";
import { Button } from "components/generic/inputs/Button";
import { IconButtonWithTooltip } from "components/generic/inputs/IconButtonWithTooltip";
import { Scroll } from "components/generic/Scrollbars";
import { getColorHex } from "components/renderer/colors";
import { isEmpty, pick, startCase } from "es-toolkit/compat";
import { highlightNodesOptions } from "hooks/useHighlight";
import type { D2RendererV2 } from "internal-renderers/src/d2-renderer/D2RendererV2";
import { ReactNode } from "react";
import { getShade, useAcrylic, usePaper } from "theme";
import { SharedGraphProps } from "../SharedGraphProps";
import { useHighlighting } from "../useHighlighting";

const divider = <Divider orientation="vertical" flexItem sx={{ m: 1 }} />;

function Dot({ color }: { color?: string }): ReactNode {
  return (
    <Tooltip title={color ?? ""}>
      <FiberManualRecord sx={{ fontSize: "0.8em", color, verticalAlign: "middle" }} />
    </Tooltip>
  );
}

/** The banner and border shown while a focused view (a highlight) is active. */
export function FocusedView({ trace, layer: key, onExit }: SharedGraphProps) {
  const acrylic = useAcrylic();
  const theme = useTheme();
  const highlighting = useHighlighting(key);
  const enabled = !isEmpty(highlighting);

  const bg = getShade(
    highlightNodesOptions.find((h) => h.type === highlighting?.type)?.color,
    theme.palette.mode,
    500,
    400,
  );
  const event = trace?.events?.[highlighting?.step ?? 0];

  return (
    <Stack
      sx={{
        width: "100%",
        height: "100%",
        position: "absolute",
        top: 0,
        left: 0,
        pt: 6,
        pointerEvents: "none",
      }}
    >
      <Stack
        sx={{
          width: "100%",
          height: "100%",
          border: enabled ? `2px solid ${bg}` : "none",
          // The top bar has a 0.5px border, so the graph's top border needs to be
          // 0.5px thicker to line up.
          borderTopWidth: "2.5px",
          transition: (t) => t.transitions.create("box-shadow"),
        }}
      >
        {enabled && (
          <Scroll x style={{ height: theme.spacing(5) }}>
            <Box
              sx={{
                ...pick(acrylic, "backdropFilter"),
                transition: (t) => t.transitions.create("background-color"),
                pointerEvents: "all",
                alignItems: "center",
                p: 2,
                height: "100%",
                bgcolor: alpha(bg, 0.05) || "info.main",
                display: "flex",
                justifyContent: "space-between",
                minWidth: "max-content",
                gap: 2,
              }}
            >
              <Typography variant="overline">
                {startCase(highlighting?.type)}{" "}
                <Box sx={{ opacity: 0.7 }} component="span">
                  <Dot color={getColorHex(event?.type)} /> {startCase(event?.type)} {event?.id}
                  {", "}
                  Step {highlighting?.step}{" "}
                </Box>
              </Typography>
              <Button onClick={onExit} variant="outlined" sx={{ mr: -1, height: theme.spacing(4) }}>
                Exit focused view
              </Button>
            </Box>
          </Scroll>
        )}
      </Stack>
    </Stack>
  );
}

/**
 * Fit / rotate / playback. Fit goes through the renderer's own camera now, rather
 * than sigma's — `fitCamera` reads the layers' shared Flatbush bounds, so it needs
 * no separate record of where the content is.
 */
export function GraphControls({
  layer: key,
  renderer,
  isHighlightingEnabled,
  setOrientation,
  orientation,
}: {
  layer?: string;
  renderer?: D2RendererV2;
  isHighlightingEnabled: boolean;
  setOrientation?: (orientation: "horizontal" | "vertical") => void;
  orientation?: "horizontal" | "vertical";
}) {
  const paper = usePaper();
  const acrylic = useAcrylic();
  return (
    <Stack
      sx={{
        pt: isHighlightingEnabled ? 11 : 6,
        transition: (t) => t.transitions.create("padding-top"),
        position: "absolute",
        top: 0,
        left: 0,
      }}
    >
      <Stack
        direction="row"
        sx={
          {
            ...paper(1),
            ...acrylic,
            alignItems: "center",
            height: (t) => t.spacing(6),
            px: 1,
            m: 1,
          } as SxProps<Theme>
        }
      >
        <IconButtonWithTooltip
          color="primary"
          disabled={!renderer}
          onClick={() => renderer?.fitCamera()}
          label="Fit"
          icon={<CenterFocusWeakOutlined />}
        />
        {divider}
        {orientation && (
          <>
            <IconButtonWithTooltip
              color="primary"
              onClick={() =>
                setOrientation?.(orientation === "vertical" ? "horizontal" : "vertical")
              }
              label="Rotate"
              icon={<RotateIcon />}
            />
            {divider}
          </>
        )}
        <MinimisedPlaybackControls layer={key} />
      </Stack>
    </Stack>
  );
}
