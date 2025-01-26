import { Typography as Type } from "@mui/material";
import { ReactNode as Node } from "react";
import { Block } from "components/generic/Block";
import { Space } from "components/generic/Space";

export const Heading = ({ label }: { label?: Node }) => (
  <Type
    component="div"
    variant="overline"
    color="text.secondary"
    sx={{ pt: 1 }}
  >
    {label}
  </Type>
);

export const Label = ({ label }: { label?: Node }) => (
  <Type component="div" variant="body1">
    {label}
  </Type>
);

export const Option = ({
  label,
  content,
}: {
  label?: Node;
  content?: Node;
}) => (
  <Block alignItems="center">
    <Label label={label} />
    <Space flex={1} />
    {content}
  </Block>
);
