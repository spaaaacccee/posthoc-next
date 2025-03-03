import { SelectField as Select } from "components/generic/inputs/Select";
import { DebugLayerData } from "hooks/useBreakPoints";
import { Steps } from "layers/LayerController";
import { getController } from "layers/layerControllers";
import { map, startCase, uniq } from "lodash-es";
import { _ } from "utils/chain";
import { useMemo } from "react";
import { slice } from "slices";
import { Layer } from "slices/layers";
import { equal } from "slices/selector";
import { BreakpointFieldProps } from "../breakpoints/Breakpoint";

export const EventSelect = ({
  layer,
  ...props
}: BreakpointFieldProps<string>) => {
  "use no memo";
  const one = slice.layers.one<Layer<DebugLayerData>>(layer);
  const { steps } =
    one.use<Steps | undefined>(
      (l) => getController(l)?.steps?.(l),
      equal("key")
    ) ?? {};
  const types = useMemo(() => _(steps, (v) => map(v, "type"), uniq), [steps]);
  return (
    <Select
      disabled={props.disabled}
      variant="outlined"
      placeholder="Event"
      sx={{ minWidth: 160 }}
      items={[
        {
          value: "",
          label: "Any",
        },
        ...map(types, (c) => ({ value: c!, label: startCase(c) })),
      ]}
      onChange={(v) => props.onChange?.(v)}
      value={props?.value ?? ""}
    />
  );
};
