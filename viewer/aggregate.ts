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

/** How many groups a directory must hold before it reads as a container rather
 * than as a place — see the label pass in {@link labelsFor}. */
const CONTAINER_FAMILY = 4;

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
 * Directory names that describe a FILE'S ROLE rather than a component.
 *
 * `CMU_LIBS/elmMcl/headers` and `CMU_LIBS/elmMcl/sources` are one module split by
 * language convention, not two modules — grouping by them halves every module and
 * puts its declarations in a different bubble from its definitions.
 *
 * This list is the part that cannot be derived: these words are conventions of
 * the wider programming culture, not facts about any one repo. Everything else a
 * grouping should ignore is worked out from the tree itself — see
 * {@link transparentDirs}, which is what keeps this list from having to grow a
 * new entry every time a repo invents a folder that means nothing.
 */
const ROLE_NAMES = new Set([
  "src", "source", "sources", "lib",
  "include", "includes", "inc", "header", "headers",
  "impl", "internal", "private", "public", "detail",
]);

/** Extension → the directory names that would be naming that same language. */
const LANGUAGE_DIRS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "rb", "go", "rs",
  "java", "kt", "swift", "php", "cs", "lua", "dart", "cpp", "cc", "cxx", "hpp",
  "h", "c", "css", "scss", "sass", "less", "html", "qml", "sh", "sql", "json",
  "javascript", "typescript", "python", "ruby", "golang", "rust", "kotlin",
]);

/**
 * Directories that carry no identity — worked out from the repo's own tree.
 *
 * A hardcoded list of names is the wrong shape for this: it says `sources` is a
 * convention everywhere and says nothing about the folder a particular project
 * invented. Two rules cover the rest, and both are properties of the tree rather
 * than of any vocabulary:
 *
 *   - A directory NAMED AFTER A LANGUAGE that holds files of that language sorts
 *     by what its files are written in, which is the same kind of fact as
 *     `headers`. `qmlSources/jS` full of `.js` is a file-type folder wearing a
 *     different word. A directory called `go` holding no Go is somebody's module
 *     and is left alone.
 **
 * Keyed by full path, not by name, so a `scripts/` that really does hold a repo's
 * build scripts stays a component while a `scripts/` that is one empty step in a
 * chain does not.
 */
export function transparentDirs(graph: VizGraph): Set<string> {
  interface Dir { children: Set<string>; files: number; exts: Set<string> }
  const dirs = new Map<string, Dir>();
  const dirAt = (key: string): Dir => {
    let d = dirs.get(key);
    if (!d) dirs.set(key, (d = { children: new Set(), files: 0, exts: new Set() }));
    return d;
  };

  for (const n of graph.nodes) {
    const path = pathOf(n);
    if (!path) continue;
    const parts = path.split("/");
    const ext = parts[parts.length - 1].split(".").pop()?.toLowerCase() ?? "";
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join("/");
      const dir = dirAt(key);
      dir.exts.add(ext);
      if (i === parts.length - 2) dir.files++;
      else dir.children.add(parts.slice(0, i + 2).join("/"));
    }
  }

  const out = new Set<string>();
  for (const [key, dir] of dirs) {
    const name = key.slice(key.lastIndexOf("/") + 1).toLowerCase();
    // A "one child, no files of its own" rule was tried here too and is wrong: a
    // real module whose only child is `headers/` has exactly that shape, and it
    // dissolved `CMU_LIBS/elmModels` into its parent. Structure alone cannot tell
    // a module from a filler folder — what a filler folder actually costs is a
    // LABEL nobody can place, and that is fixed where labels are made.
    if (LANGUAGE_DIRS.has(name) && dir.exts.has(name)) out.add(key);
  }
  return out;
}

/**
 * Path segments that carry identity: the ones worth grouping by.
 *
 * A file whose every directory is a convention — `sources/main.cpp`, `src/app.ts`
 * — belongs to no module but the repo itself, and says so by returning nothing.
 * Falling back to the conventions in that case put `sources` and `headers`
 * bubbles at the top level of a C++ tree: precisely the meaningless grouping this
 * exists to prevent.
 *
 * `transparent` is the repo-derived half (see {@link transparentDirs}); without
 * it only the universal conventions are stripped, which is the right answer for
 * a caller that has a path but no tree.
 */
export function significantDirs(path: string, transparent?: ReadonlySet<string>): string[] {
  const dirs = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 0; i < dirs.length; i++) {
    if (ROLE_NAMES.has(dirs[i].toLowerCase())) continue;
    if (transparent?.has(dirs.slice(0, i + 1).join("/"))) continue;
    out.push(dirs[i]);
  }
  return out;
}

/**
 * The group a path belongs to: its first `depth` MEANINGFUL directory segments.
 *
 * The filename is never part of the key — group by it and every file is its own
 * group, which is not aggregation. A path with no directory at all is its own
 * group rather than being lifted into the repo root, so a top-level `main.cpp`
 * stays visible instead of disappearing into a bubble named after the repo.
 */
export function groupKeyOf(path: string, depth: number, transparent?: ReadonlySet<string>): string {
  return significantDirs(path, transparent).slice(0, depth).join("/");
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
  const transparent = transparentDirs(graph);
  let deepest = 0;
  for (const n of graph.nodes) deepest = Math.max(deepest, significantDirs(pathOf(n), transparent).length);
  return deepest + 1;
}

/** The group key for files that belong to no module — the repo's own code. */
export const ROOT_GROUP = "";

/** The directory depths this graph can meaningfully be grouped at, shallowest
 * first — so the UI offers the levels a repo actually has rather than a guess. */
export function availableDepths(graph: VizGraph): number[] {
  const transparent = transparentDirs(graph);
  let max = 0;
  for (const n of graph.nodes) {
    const dirs = significantDirs(pathOf(n), transparent).length;
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
  const parts_ = (k: string): string[] => parts.get(k)!;
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
  /*
   * Keep the parent when the parent says something.
   *
   * `CMU_LIBS/elmMclUa` reads perfectly as "elmMclUa": forty groups sit under
   * `CMU_LIBS`, so naming it adds a word every bubble already shares. `web/project`
   * as "project" reads as nothing at all — and the difference between those two
   * cases is not the words, it is how many groups the parent holds. A parent
   * shared by a handful is a place; a parent shared by everything is a container.
   *
   * So the parent is kept for the small families and dropped for the big ones,
   * which needs no vocabulary of filler names and gets repo-specific folders
   * (`project`, `apps`, `packages`) right without ever having heard of them.
   */
  const family = new Map<string, number>();
  for (const k of keys) {
    const parent = parts_(k).slice(0, -1).join("/");
    if (parent) family.set(parent, (family.get(parent) ?? 0) + 1);
  }
  for (const k of keys) {
    const parent = parts_(k).slice(0, -1).join("/");
    if (parent && (family.get(parent) ?? 0) < CONTAINER_FAMILY) {
      depthOf.set(k, Math.max(depthOf.get(k)!, 2));
    }
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
  // Derived from the graph being grouped, not from the scoped subset: drilling
  // into a subtree must not change what counts as a directory in it.
  const transparent = transparentDirs(graph);
  const groupOf = new Map<string, string>();
  const groups = new Map<string, { key: string; members: number; internal: number }>();
  for (const n of nodes) {
    const key = byFile ? pathOf(n) : groupKeyOf(pathOf(n), opts.depth, transparent);
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
