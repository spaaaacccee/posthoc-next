import plur from "plur";

/**
 * Count-inclusive pluralisation, e.g. `pluralize("edge", 3)` -> `"3 edges"`,
 * `pluralize("edge", 1)` -> `"1 edge"`. Drop-in for the old
 * `pluralize(word, count, true)` (the CommonJS `pluralize` package), now backed
 * by the ESM-only `plur`.
 */
export function pluralize(word: string, count: number) {
  return `${count} ${plur(word, count)}`;
}
