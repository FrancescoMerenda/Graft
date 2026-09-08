/**
 * Edges that carry dependency meaning for a graph walk/rank: `calls`,
 * `references`, `imports`, `implements`, `extends`. `contains` is deliberately
 * excluded — a file "contains" every symbol defined in it, so walking it
 * would make every same-file symbol a neighbour and let a file act as a false
 * hub, flooding a walk that must stay confined to genuine dependency wiring.
 *
 * Shared by `traverse.ts` (callers/callees/impact edge walks), `graphrank.ts`
 * (personalized PageRank), and `search/grep.ts` (in-degree ranking) so every
 * surface agrees on what counts as a dependency edge.
 */
import type { Relation } from "./types.js";

export const WALK_RELATIONS: ReadonlySet<Relation> = new Set<Relation>([
  "calls",
  "references",
  "imports",
  "implements",
  "extends",
]);

/**
 * Parse a caller-supplied relation filter into a subset of {@link WALK_RELATIONS}.
 *
 * "Who calls `parse`" and "who inherits from `Node`" are different questions, and
 * a walk that answers both at once answers neither: the output interleaves them
 * and the reader is left grepping their own results. So the walk takes a subset,
 * defaulting to all of them.
 *
 * Accepts a comma-separated string, a repeated flag's array, or any mix of the
 * two — the CLI and MCP hand this the shape their own argument parser produced,
 * and neither should have to normalise first. An unknown name is an error rather
 * than a silent no-op, because a typo'd filter otherwise reads as "nothing
 * inherits from this".
 */
export function parseWalkRelations(input: string | string[]): { ok: Relation[] } | { error: string } {
  const raw = (Array.isArray(input) ? input : [input])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (raw.length === 0) return { error: "no relation given" };

  const known = [...WALK_RELATIONS];
  const out: Relation[] = [];
  for (const name of raw) {
    const hit = known.find((r) => r === name);
    if (!hit) {
      return { error: `unknown relation "${name}" — expected one of ${known.join(", ")}` };
    }
    if (!out.includes(hit)) out.push(hit);
  }
  return { ok: out };
}
