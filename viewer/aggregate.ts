/**
 * Grouping a graph too large to read into one that is.
 *
 * 26,000 symbols laid out at once is a picture with no content: every node is a
 * dot, every edge is part of a smear, and the only question it answers is "is this
 * codebase big". The answer is not a faster renderer — it is fewer, larger nodes.
 * Rolled up by directory, the same graph says `elmMcl` leans on `elmSip` with 47
 * references and on `elmRtp` with 12, which is the shape people actually reason
 * about.
 *
 * Everything here is a pure transform over the viewer's own graph type, applied in
 * front of the renderer. The renderer draws whatever node and edge arrays it is
 * given and knows nothing about grouping.
 */
import type { VizGraph, VizNode, VizEdge } from "./data.js";

/** Symbol pairs kept verbatim on a bundle before the count takes over. */
const MAX_BUNDLE_MEMBERS = 40;

export interface GroupOptions {
  /** Path segments that make a group. 0 means no grouping at all. */
  depth: number;
  /** Restrict to one subtree first, e.g. drilling into `CMU_LIBS/elmMcl`. */
  scope?: string;
  /** Drop symbols with no edges at all. */
  hideOrphans?: boolean;
}

/** `a/b/c.cpp` from a node, falling back to the `path · span` form the context
 * tab carries in `sources`. */
export function pathOf(node: VizNode): string {
  if (node.path) return node.path;
  const first = node.sources?.[0];
  return first ? first.split(" · ")[0] : "";
}

/**
 * Directory names that describe a FILE TYPE rather than a component.
 *
 * `CMU_LIBS/elmMcl/headers` and `CMU_LIBS/elmMcl/sources` are one module split by
 * language convention, not two modules — grouping by them halves every module and
 * puts its declarations in a different bubble from its definitions. Worse, every
 * submodule has both, so the top level of a C++ tree ends up with bubbles called
 * `headers` and `sources` that mean nothing at all.
 *
 * Recognised rather than inferred. A frequency heuristic ("a name under many
 * parents is a convention") gets this right on a repo with fifty submodules and
 * badly wrong on one with three, and a viewer that regroups differently depending
 * on repo size is worse than one that is occasionally too literal.
 */
const FILE_TYPE_DIRS = new Set([
  "src", "source", "sources", "lib",
  "include", "includes", "inc", "header", "headers",
  "impl", "internal", "private", "public", "detail",
]);

/**
 * Path segments that carry identity: the ones worth grouping by.
 *
 * A file whose every directory is a convention — `sources/main.cpp`, `src/app.ts`
 * — belongs to no module but the repo itself, and says so by returning nothing.
 * The earlier version fell back to the conventions in that case, which put
 * `sources` and `headers` bubbles at the top level of a C++ tree: precisely the
 * meaningless grouping this exists to prevent.
 */
export function significantDirs(path: string): string[] {
  return path.split("/").slice(0, -1).filter((d) => !FILE_TYPE_DIRS.has(d.toLowerCase()));
}

/**
 * The group a path belongs to: its first `depth` MEANINGFUL directory segments.
 *
 * The filename is never part of the key — group by it and every file is its own
 * group, which is not aggregation. A path with no directory at all is its own
 * group rather than being lifted into the repo root, so a top-level `main.cpp`
 * stays visible instead of disappearing into a bubble named after the repo.
 */
export function groupKeyOf(path: string, depth: number): string {
  return significantDirs(path).slice(0, depth).join("/");
}

/**
 * The depth at which grouping switches from directories to individual files.
 *
 * A property of the GRAPH, not of any one path: a top-level `main.cpp` has no
 * directories of its own, but it must not become a file bubble while everything
 * beside it is still grouped by module. One past the deepest directory anywhere
 * in the graph is the rung where every path has run out of directories together.
 */
export function fileRungOf(graph: VizGraph): number {
  let deepest = 0;
  for (const n of graph.nodes) deepest = Math.max(deepest, significantDirs(pathOf(n)).length);
  return deepest + 1;
}

/** The group key for files that belong to no module — the repo's own code. */
export const ROOT_GROUP = "";

/** The directory depths this graph can meaningfully be grouped at, shallowest
 * first — so the UI offers the levels a repo actually has rather than a guess. */
export function availableDepths(graph: VizGraph): number[] {
  let max = 0;
  for (const n of graph.nodes) {
    const dirs = significantDirs(pathOf(n)).length;
    if (dirs > max) max = dirs;
  }
  // One past the deepest directory: that level groups by file.
  return Array.from({ length: Math.min(max + 1, 5) }, (_, i) => i + 1);
}

/**
 * Short labels for a set of group paths, lengthened only where they would clash.
 *
 * The last path segment is what a reader wants — `elmMcl`, not
 * `CMU_LIBS/elmMcl`. But a tree that repeats a folder name has several groups
 * ending in `web`, `snmp`, `ws`, and rendering three identical labels is worse
 * than rendering long ones: the picture stops being a map of anything. So each
 * clashing label takes one more segment from the left, repeatedly, until it is
 * unique among the labels it clashed with.
 */
export function labelsFor(keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const parts = new Map(keys.map((k) => [k, k.split("/")]));
  const depthOf = new Map(keys.map((k) => [k, 1]));
  const labelAt = (k: string, d: number): string => parts.get(k)!.slice(-d).join("/");

  for (;;) {
    const byLabel = new Map<string, string[]>();
    for (const k of keys) {
      const l = labelAt(k, depthOf.get(k)!);
      const bucket = byLabel.get(l);
      if (bucket) bucket.push(k);
      else byLabel.set(l, [k]);
    }
    let grew = false;
    for (const [, clashing] of byLabel) {
      if (clashing.length < 2) continue;
      for (const k of clashing) {
        const d = depthOf.get(k)!;
        // Already showing the whole path: two groups genuinely share a name and
        // there is nothing left to add.
        if (d >= parts.get(k)!.length) continue;
        depthOf.set(k, d + 1);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const k of keys) out.set(k, labelAt(k, depthOf.get(k)!));
  return out;
}

/**
 * Roll a graph up to `depth` directory levels.
 *
 * Edges inside a group are not drawn — they would be a self-loop on the bubble —
 * but they are counted, because "400 symbols talking mostly to each other" is
 * exactly what a reader wants to know about a bubble before opening it.
 */
export function groupGraph(graph: VizGraph, opts: GroupOptions): VizGraph {
  const inScope = (n: VizNode): boolean => {
    if (!opts.scope) return true;
    const p = pathOf(n);
    return p === opts.scope || p.startsWith(`${opts.scope}/`);
  };
  let nodes = graph.nodes.filter(inScope);
  let kept = new Set(nodes.map((n) => n.id));
  let edges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target));

  if (opts.hideOrphans) {
    const linked = new Set<string>();
    for (const e of edges) { linked.add(e.source); linked.add(e.target); }
    nodes = nodes.filter((n) => linked.has(n.id));
    kept = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  }

  if (opts.depth <= 0) {
    return { ...graph, nodes, edges, meta: { ...graph.meta, nodeCount: nodes.length, edgeCount: edges.length } };
  }

  // Past the last directory level, group by file — the rung between "modules" and
  // "four hundred individual functions" that drilling otherwise has to jump.
  const byFile = opts.depth >= fileRungOf(graph);
  const groupOf = new Map<string, string>();
  const groups = new Map<string, { key: string; members: number; internal: number }>();
  for (const n of nodes) {
    const key = byFile ? pathOf(n) : groupKeyOf(pathOf(n), opts.depth);
    groupOf.set(n.id, key);
    const g = groups.get(key);
    if (g) g.members++;
    else groups.set(key, { key, members: 1, internal: 0 });
  }

  const rolled = new Map<string, VizEdge>();
  for (const e of edges) {
    const a = groupOf.get(e.source);
    const b = groupOf.get(e.target);
    if (a === undefined || b === undefined) continue;
    if (a === b) { groups.get(a)!.internal++; continue; }
    // One bundle per ordered pair per relation: direction is the whole point of a
    // dependency graph, and merging `uses` into `part of` would erase the grammar
    // the edge styling depends on.
    const key = `${a} ${b} ${e.relation}`;
    const prev = rolled.get(key);
    if (prev) {
      prev.weight = (prev.weight ?? 1) + 1;
      // Keep the real symbol pairs, so the panel can answer "which call?" rather
      // than only "these two are connected". Capped: one bundle here reaches four
      // figures, and nobody reads a four-figure list — the count carries the rest.
      if (prev.members!.length < MAX_BUNDLE_MEMBERS) prev.members!.push({ source: e.source, target: e.target });
      else prev.moreMembers = (prev.moreMembers ?? 0) + 1;
    } else {
      rolled.set(key, {
        source: `group:${a}`, target: `group:${b}`, relation: e.relation, weight: 1,
        members: [{ source: e.source, target: e.target }],
      });
    }
  }

  const label = labelsFor([...groups.keys()].filter((k) => k !== ROOT_GROUP));
  // The repo's own top-level code is one thing, named after the repo rather than
  // after whichever convention directory it happens to sit in.
  label.set(ROOT_GROUP, graph.meta.repoName ?? "root");
  const groupNodes: VizNode[] = [...groups.values()].map((g) => ({
    id: `group:${g.key}`,
    name: label.get(g.key) ?? g.key,
    type: "group",
    summary: `${g.key} — ${g.members} symbols · ${g.internal} internal references`,
    sources: [g.key],
    path: g.key,
    count: g.members,
  }));

  return {
    ...graph,
    nodes: groupNodes,
    edges: [...rolled.values()],
    meta: { ...graph.meta, nodeCount: groupNodes.length, edgeCount: rolled.size },
  };
}
