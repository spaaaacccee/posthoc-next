import { Dictionary as Dict } from "lodash-es";
import { CompiledComponent, EventContext, Properties as Props } from "protocol";

export type Context<T extends Props = Record<string, any>> =
  | PropMap<T>
  | EventContext
  | CompiledComponent<string, T>;

export type Key<T> = Extract<keyof T, string>;

export type Prop<T extends Props> = (ctx: Context<T>) => T[keyof T];

export type PropMap<T extends Props> = Dict<Prop<T>>;
