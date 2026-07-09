import { nanoid } from "nanoid";
import { Trace } from "protocol/Trace-v140";
import { set } from "utils/set";
import { parseYamlAsync } from "workers/async";
import { Controller } from "./types";

export const onEditSource = (async (layer, id, content) => {
  if (id !== "trace") throw { error: "id not trace", id };
  if (!content) throw { error: "content is undefined", layer, content };

  const { result, error } = await parseYamlAsync({ content });
  if (error) throw { error };
  // Shallow-freeze so immer's auto-freeze skips this (large) graph instead of
  // deep-freezing every event on commit (see upload.tsx / readUploadedTrace).
  if (result) Object.freeze(result);
  // Set the trace content
  set(layer, "source.trace.content", result as Trace | undefined);
  // To get things to change, we also need to change the trace key
  set(layer, "source.trace.key", nanoid());
  set(layer, "source.trace.id", id);
}) satisfies Controller["onEditSource"];
