import { isNull, isUndefined } from "es-toolkit";

export const isDefined = (a: unknown) => !isUndefined(a) && !isNull(a);
