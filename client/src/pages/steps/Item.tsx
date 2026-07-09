import { Box, Divider } from "@mui/material";
import { WhenIdle } from "components/generic/LazyList";
import { EventInspector, Skeleton } from "components/inspector/EventInspector";
import { ITEM_HEIGHT } from "./constants";
import { useItemPlaybackState } from "./useItemPlaybackState";
import { useItemState } from "./useItemState";

export function Item({
  layer,
  event: eventProp,
  disabled,
}: {
  index?: number;
  disabled?: boolean;
  layer?: string;
  event?: number;
}) {
  // Defaults are applied in the body rather than in the destructure: an
  // object-destructuring default makes babel-plugin-react-compiler bail out of
  // memoizing the whole component.
  const eventIndex = eventProp ?? 0;

  const { stepTo, playing } = useItemPlaybackState(layer);
  const { event, isSelected, label } = useItemState({
    layer,
    index: eventIndex,
  });
  return (
    <Box sx={{ height: ITEM_HEIGHT }}>
      <WhenIdle>
        {playing ? (
          <Skeleton event={event} />
        ) : (
          <EventInspector
            sx={{ opacity: disabled ? 0.25 : 1 }}
            event={event}
            index={eventIndex}
            selected={isSelected}
            label={label}
            onClick={() => stepTo(eventIndex)}
          />
        )}
      </WhenIdle>
      <Divider variant="inset" />
    </Box>
  );
}
