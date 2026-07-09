import { readTrace } from "components/renderer/parser-v140/readTrace";
import { nanoid } from "nanoid";
import { set } from "utils/set";
import { parseYamlAsync } from "workers/async";
import { Controller } from "./types";

export const onEditSource = (async (layer, id, content) => {
  if (id !== "trace") throw { error: "id not trace", id };
  if (!content) throw { error: "content is undefined", layer, content };

  const { result, error } = await parseYamlAsync({ content });
  if (error) throw { error };
  // Set the trace content. `readTrace` upgrades pre-1.4.0 traces and
  // shallow-freezes, so immer's auto-freeze skips this (large) graph instead of
  // deep-freezing every event on commit.
  set(layer, "source.trace.content", readTrace(result));
  // To get things to change, we also need to change the trace key
  set(layer, "source.trace.key", nanoid());
  set(layer, "source.trace.id", id);
}) satisfies Controller["onEditSource"];
