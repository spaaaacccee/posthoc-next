import { useTheme } from "@mui/material";
import { colorsHex } from "components/renderer/colors";
import { mapValues } from "es-toolkit/compat";
import { EventContext } from "protocol";
import { useMemo } from "react";
import { AccentColor, accentColors, getShade } from "theme";

/**
 * The rendering context (theme colours + accent palette) handed to the frame
 * generator. Shared by the streaming path and the v2 component-store builder so
 * both produce identical colours — the store is generated from this context, so
 * any drift would render the wrong fills.
 */
export function useEventContext(): EventContext {
  const { palette } = useTheme();
  return useMemo(
    () => ({
      theme: {
        foreground: palette.text.primary,
        background: palette.background.paper,
        accent: palette.primary.main,
      },
      color: {
        ...colorsHex,
        ...mapValues(accentColors, (_, v: AccentColor) => getShade(v, palette.mode, 500, 400)),
      },
      themeAccent: palette.primary.main,
      themeTextPrimary: palette.text.primary,
      themeBackground: palette.background.paper,
    }),
    [palette],
  );
}
