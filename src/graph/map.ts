/**
 * `graft map` core: a deterministic, token-budgeted repo orientation —
 * directory clusters, per-directory hubs, and global hotspots — computed
 * purely from the wiring graph (no LLM, no I/O beyond the already-loaded
 * `GraphV1`).
 *
 * Grouping is by first path segment (`src/cache.ts` → `src`), so a coding
 * agent gets the same top-level shape a human sees in a file tree. When one
 * segment swallows most of the repo (a flat `src/` with everything under
 * it), that single group would be useless as an orientation aid, so it gets
 * one refinement pass: split one level deeper (`src` → `src/ask`,
 * `src/graph`, …). Hubs and hotspots rank by incoming `WALK_RELATIONS`
 * edges (shared with `graphrank.ts`/`grep.ts`, so "important" means the same
 * thing everywhere in graft) — never by lines of code or heuristics that
 * drift from the actual wiring.
 *
 * Pure and synchronous: same fixture-testable shape as `grep.ts` — no CLI or
 * MCP concerns live here. `cli.ts` and `mcp/tools.ts` both call
 * `buildRepoMap` + `formatRepoMap` directly.
 */
import type { GraphV1, NodeV1 } from "./types.js";
import { languageLabelOf } from "./extract.js";
import { containerLangOf } from "./container.js";
import { genericLangOf } from "./generic.js";
import { WALK_RELATIONS } from "./relations.js";
import { scopeLabel, scopeOf, scopesOfGraph } from "./scopes.js";
import { withSavings, savingsFor, type Savings } from "../context/savings.js";

export interface Hub {
  name: string;
  kind: string;
  path: string;
  span: string;
  inDegree: number;
}

export interface DirEntry {
  path: string;
  files: number;
  symbols: number;
  languages: string[];
  hubs: Hub[];
  /** True when the >60% split refinement bottomed out on a file that sits
   * directly in the split directory (no deeper subdirectory to split into —
   * see `dirKey`'s doc). In that case `path` IS a file's own full path, not
   * a directory, so `formatDirLine` must not append a trailing "/". False
   * for every real directory group (the overwhelming majority). */
  isFile: boolean;
}

/** One scope's own directory breakdown — same shape a single-scope `buildRepoMap`
 * would produce for that scope's nodes alone, dir paths repo-rooted (not
 * scope-relative) so a hit is directly openable without mentally re-prefixing. */
export interface ScopeGroup {
  /** Display label via `scopeLabel` — "(root)" or "backend/". */
  scope: string;
  /** Sorted by symbol count desc (ties by path asc), capped at `maxDirs`. */
  dirs: DirEntry[];
  /** This scope's directory groups beyond the `maxDirs` cap. */
  dropped: number;
}

/**
 * One directory's dependency on another, rolled up from the symbol edges that
 * cross between them.
 *
 * The per-directory lines say how big each part of the repo is and what its
 * hubs are; nothing said which parts LEAN ON which. That is the first question
 * anyone asks of an unfamiliar codebase, it is the one thing a file tree can
 * never answer, and the graph has held the answer all along.
 */
export interface DepEdge {
  /** Depending directory (or file, when the split refinement bottomed out). */
  from: string;
  /** Depended-upon directory. */
  to: string;
  /** Whether each end is a file rather than a directory — same distinction (and
   * same cause) as {@link DirEntry.isFile}, so the renderer knows which end may
   * take a trailing "/". */
  fromIsFile: boolean;
  toIsFile: boolean;
  /** Crossing edges in total — the bundle's weight. */
  total: number;
  /** The breakdown, strongest relation first: `calls` and `extends` mean very
   * different things about a dependency, and merging them loses that. */
  byRelation: { relation: string; count: number }[];
}

export interface RepoMap {
  totals: { files: number; symbols: number; edges: number; languages: string[] };
  /** Single-scope repos: sorted by symbol count desc (ties by path asc), capped
   * at `maxDirs`. Multi-scope repos: empty — use `scopes` instead (see below). */
  dirs: DirEntry[];
  /** Multi-scope repos ONLY (`scopesOfGraph(graph).length > 1`): one entry per
   * scope, scope label as the top-level group key, that scope's own dirs
   * second — a monorepo's sub-projects each read like their own little map
   * instead of being pooled by raw first-path-segment. Absent on single-scope
   * repos (the byte-identical-output regression guarantee: same
   * `scopesOfGraph(g).length <= 1` early branch `ask.ts` uses). */
  scopes?: ScopeGroup[];
  /** Global top hubs by inDegree, ties by name asc then path asc. */
  hotspots: Hub[];
  /** Inter-directory dependency bundles, heaviest first, capped at `maxDeps`.
   * Grouped by the same keys as `dirs`/`scopes` (so a line names groups the
   * reader has just seen), but ranked independently of the `maxDirs` cap — a
   * heavy dependency is worth reporting even when one of its ends fell off the
   * directory list. */
  deps: DepEdge[];
  /** Dependency bundles beyond the `maxDeps` cap. */
  depsDropped: number;
  /** Directory groups beyond the `maxDirs` cap — never silently dropped.
   * Multi-scope repos: always 0 here; see each `ScopeGroup.dropped` instead. */
  dropped: number;
  /** Tokens-saved baseline: every indexed file read whole — the cost of
   * orienting by reading the repo instead of this map. */
  saved?: Savings;
}

export interface BuildRepoMapOptions {
  /** Max directory entries kept (the rest are counted into `dropped`). Default 16. */
  maxDirs?: number;
  /** Max hubs listed per directory. Default 3. */
  hubsPerDir?: number;
  /** Max global hotspots. Default 12. */
  hotspots?: number;
  /** Max inter-directory dependency bundles listed. Default 12. */
  maxDeps?: number;
}

const DEFAULT_MAX_DIRS = 16;
const DEFAULT_HUBS_PER_DIR = 3;
const DEFAULT_HOTSPOTS = 12;
const DEFAULT_MAX_DEPS = 12;
/** A single group must not exceed this share of all file nodes, or it's
 * refined one path-segment deeper — see the module doc. */
const SPLIT_THRESHOLD = 0.6;

/** First `depth` path segments, joined back with `/`. Files with fewer
 * segments than `depth` (e.g. a root-level file at depth 2) just use every
 * segment they have — there's nothing deeper to split into. */
function dirKey(path: string, depth: number): string {
  const segments = path.split("/");
  return segments.slice(0, Math.min(depth, segments.length)).join("/");
}

/** Incoming WALK_RELATIONS edge count per target id — the same "coupling"
 * metric `grep.ts` uses, so a hub in `graft map` means the same thing as a
 * high-inDegree group in `graft grep`. */
function computeInDegree(graph: GraphV1): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    if (!WALK_RELATIONS.has(e.relation)) continue;
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

/** Top `cap` nodes by inDegree (ties broken by name asc, then path asc, for
 * full determinism regardless of the input nodes' array order), dropping
 * anything with zero inbound edges — a hub with no callers isn't a hub. */
function topHubs(nodes: NodeV1[], inDegree: Map<string, number>, cap: number): Hub[] {
  return nodes
    .map((n) => ({ name: n.name, kind: n.kind, path: n.path, span: n.span, inDegree: inDegree.get(n.id) ?? 0 }))
    .filter((h) => h.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    .slice(0, cap);
}

/**
 * Display labels, not tree-sitter grammars: a `scripts/` tree of `.mjs` files is
 * "javascript" here, not "typescript". See {@link languageLabelOf}.
 *
 * All three extractor tiers are consulted, in the same order `build.ts` records
 * a file's language in. Asking only the depth tier — as this did — silently
 * dropped every breadth-tier language, so a 99% C++ repo whose only indexed
 * `.ts` files were two build scripts reported itself as "javascript,
 * typescript": not a rounding error but the wrong answer, on the one line of
 * the map a reader takes at face value.
 */
function sortedLanguages(paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    const label = languageLabelOf(p) ?? containerLangOf(p)?.name ?? genericLangOf(p)?.name;
    if (label) set.add(label);
  }
  return [...set].sort();
}

/**
 * The directory-clustering core, factored out so it can run once over the
 * whole graph (single-scope) or once per scope's own node subset
 * (multi-scope) with identical grouping/splitting/sorting rules.
 *
 * `stripPrefix` is the scope prefix to strip before computing depth/split
 * ("" for single-scope / the root scope — a no-op, `relPath` is then the
 * identity function). Reported `DirEntry.path`s are always repo-rooted
 * (the prefix is reattached), never scope-relative — a hit stays directly
 * openable without mentally re-prefixing it.
 */
function computeDirEntries(
  nodes: NodeV1[],
  inDegree: Map<string, number>,
  maxDirs: number,
  hubsPerDir: number,
  stripPrefix: string,
): { dirs: DirEntry[]; dropped: number; groupOf: Map<string, string>; fileGroups: Set<string> } {
  const fileNodes = nodes.filter((n) => n.kind === "file");
  const totalFiles = fileNodes.length;

  const relPath = (path: string): string =>
    stripPrefix === "" ? path : path === stripPrefix ? "" : path.slice(stripPrefix.length + 1);

  // Pass 1: depth-1 file counts (relative to `stripPrefix`), to find (at most
  // one) group over the split threshold — two groups can't both exceed 60%
  // of the same total.
  const depth1FileCounts = new Map<string, number>();
  for (const n of fileNodes) {
    const key = dirKey(relPath(n.path), 1);
    depth1FileCounts.set(key, (depth1FileCounts.get(key) ?? 0) + 1);
  }
  let splitSegment: string | null = null;
  if (totalFiles > 0) {
    for (const [seg, count] of depth1FileCounts) {
      if (count / totalFiles > SPLIT_THRESHOLD) {
        splitSegment = seg;
        break;
      }
    }
  }

  const depthFor = (rp: string): number => (splitSegment !== null && dirKey(rp, 1) === splitSegment ? 2 : 1);

  // Pass 2: assign every node (file and symbol alike) to its group.
  const groups = new Map<string, { files: NodeV1[]; symbols: NodeV1[] }>();
  for (const n of nodes) {
    const rp = relPath(n.path);
    const key = dirKey(rp, depthFor(rp));
    let g = groups.get(key);
    if (!g) {
      g = { files: [], symbols: [] };
      groups.set(key, g);
    }
    if (n.kind === "file") g.files.push(n);
    else g.symbols.push(n);
  }

  const fullPath = (relKey: string): string =>
    stripPrefix === "" ? relKey : relKey === "" ? stripPrefix : `${stripPrefix}/${relKey}`;

  // A group's key is a FILE's own path (not a directory) exactly when the
  // split-refinement's depth-2 grouping had nowhere deeper to go and
  // `dirKey` degenerated to the file's full relative path verbatim — see
  // `dirKey`'s doc. Detecting that by membership (rather than re-deriving
  // depth here) stays correct regardless of which pass produced the key.
  const fileRelPaths = new Set(fileNodes.map((f) => relPath(f.path)));

  const dirEntries: DirEntry[] = [...groups.entries()].map(([relKey, g]) => ({
    path: fullPath(relKey),
    files: g.files.length,
    symbols: g.symbols.length,
    languages: sortedLanguages(g.files.map((f) => f.path)),
    hubs: topHubs(g.symbols, inDegree, hubsPerDir),
    isFile: fileRelPaths.has(relKey),
  }));

  dirEntries.sort((a, b) => b.symbols - a.symbols || a.path.localeCompare(b.path));
  const dropped = Math.max(0, dirEntries.length - maxDirs);
  const dirs = dirEntries.slice(0, maxDirs);

  // The same assignment the groups above were built from, keyed by file path so
  // the edge rollup can ask "which group is this endpoint in" without redoing
  // the split/depth reasoning and risking a different answer.
  const groupOf = new Map<string, string>();
  for (const n of nodes) {
    const rp = relPath(n.path);
    if (!groupOf.has(n.path)) groupOf.set(n.path, fullPath(dirKey(rp, depthFor(rp))));
  }
  // Uncapped, unlike `dirs`: a dependency bundle can name a group that fell off
  // the directory list, and it still must not be printed as "auth.ts/".
  const fileGroups = new Set(dirEntries.filter((d) => d.isFile).map((d) => d.path));
  return { dirs, dropped, groupOf, fileGroups };
}

/**
 * Roll every crossing dependency edge up to the directory groups its endpoints
 * belong to.
 *
 * Edges INSIDE a group are dropped rather than counted: a group's internal
 * cohesion is already visible as its symbol count, and a self-dependency is not
 * something a reader can act on. Ordered pairs stay separate — `a → b` and
 * `b → a` are different facts, and a cycle between two directories is worth
 * seeing as two lines.
 */
function computeDeps(
  graph: GraphV1,
  groupOf: Map<string, string>,
  fileGroups: ReadonlySet<string>,
  maxDeps: number,
): { deps: DepEdge[]; depsDropped: number } {
  const pathOf = new Map(graph.nodes.map((n) => [n.id, n.path]));
  const bundles = new Map<string, { from: string; to: string; total: number; counts: Map<string, number> }>();

  for (const e of graph.edges) {
    if (!WALK_RELATIONS.has(e.relation)) continue;
    const sourcePath = pathOf.get(e.source);
    const targetPath = pathOf.get(e.target);
    // An unresolved endpoint (a bare module specifier, say) belongs to no
    // directory in this repo; counting it would invent a dependency.
    if (sourcePath === undefined || targetPath === undefined) continue;
    const from = groupOf.get(sourcePath);
    const to = groupOf.get(targetPath);
    if (from === undefined || to === undefined || from === to) continue;

    const key = `${from}\u0000${to}`;
    let b = bundles.get(key);
    if (!b) {
      b = { from, to, total: 0, counts: new Map() };
      bundles.set(key, b);
    }
    b.total++;
    b.counts.set(e.relation, (b.counts.get(e.relation) ?? 0) + 1);
  }

  const all: DepEdge[] = [...bundles.values()].map((b) => ({
    from: b.from,
    to: b.to,
    fromIsFile: fileGroups.has(b.from),
    toIsFile: fileGroups.has(b.to),
    total: b.total,
    byRelation: [...b.counts.entries()]
      .map(([relation, count]) => ({ relation, count }))
      .sort((x, y) => y.count - x.count || x.relation.localeCompare(y.relation)),
  }));
  all.sort((a, b) => b.total - a.total || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { deps: all.slice(0, maxDeps), depsDropped: Math.max(0, all.length - maxDeps) };
}

/**
 * Build the repo map from an already-loaded `GraphV1`. Deterministic: same
 * graph in → byte-identical `RepoMap` out (modulo insertion order, which is
 * never observed — everything meaningful is sorted).
 *
 * Single-scope repos (`scopesOfGraph(graph).length <= 1`, the overwhelming
 * majority) take the exact pre-scope-awareness path below — same branch guard
 * `ask.ts` uses, so this is a byte-level regression guarantee. Multi-scope
 * repos group `dirs` by scope FIRST (see `scopes` on `RepoMap`); `dirs` itself
 * is then empty and `scopes` carries the breakdown instead.
 */
export function buildRepoMap(graph: GraphV1, opts: BuildRepoMapOptions = {}): RepoMap {
  const maxDirs = opts.maxDirs ?? DEFAULT_MAX_DIRS;
  const hubsPerDir = opts.hubsPerDir ?? DEFAULT_HUBS_PER_DIR;
  const hotspotsN = opts.hotspots ?? DEFAULT_HOTSPOTS;

  const fileNodes = graph.nodes.filter((n) => n.kind === "file");
  const totalFiles = fileNodes.length;
  const inDegree = computeInDegree(graph);

  const scopes = scopesOfGraph(graph);
  let dirs: DirEntry[];
  let dropped: number;
  let scopeGroups: ScopeGroup[] | undefined;

  const groupOf = new Map<string, string>();
  const fileGroups = new Set<string>();
  if (scopes.length <= 1) {
    const computed = computeDirEntries(graph.nodes, inDegree, maxDirs, hubsPerDir, "");
    dirs = computed.dirs;
    dropped = computed.dropped;
    for (const [path, key] of computed.groupOf) groupOf.set(path, key);
    for (const key of computed.fileGroups) fileGroups.add(key);
  } else {
    // Multi-scope: each scope gets its OWN dir breakdown, computed exactly
    // like the single-scope path above but fed only that scope's node
    // subset (prefix stripped for depth/split math, reattached on output).
    // Grouping by raw first-path-segment instead would pool every scope
    // nested more than one segment deep (e.g. two workspace packages both
    // under `packages/`) into one shared bucket, losing the split entirely.
    dirs = [];
    dropped = 0;
    scopeGroups = scopes.map((s) => {
      const nodesInScope = graph.nodes.filter((n) => scopeOf(n.path, scopes).prefix === s.prefix);
      const computed = computeDirEntries(nodesInScope, inDegree, maxDirs, hubsPerDir, s.prefix);
      for (const [path, key] of computed.groupOf) groupOf.set(path, key);
      for (const key of computed.fileGroups) fileGroups.add(key);
      return { scope: scopeLabel(s.prefix), dirs: computed.dirs, dropped: computed.dropped };
    });
  }

  const allSymbols = graph.nodes.filter((n) => n.kind !== "file");
  const hotspots = topHubs(allSymbols, inDegree, hotspotsN);
  const { deps, depsDropped } = computeDeps(graph, groupOf, fileGroups, opts.maxDeps ?? DEFAULT_MAX_DEPS);

  return {
    totals: {
      files: totalFiles,
      symbols: allSymbols.length,
      edges: graph.edges.length,
      languages: sortedLanguages(fileNodes.map((f) => f.path)),
    },
    dirs,
    scopes: scopeGroups,
    hotspots,
    deps,
    depsDropped,
    dropped,
    saved: savingsFor(graph, fileNodes.map((f) => f.path)),
  };
}

const DIR_COL_WIDTH = 20;

function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function formatDirHub(h: Hub): string {
  return `${h.name} (${basenameOf(h.path)}, ${h.inDegree}←)`;
}

function formatDirLine(d: DirEntry): string {
  // `d.path` is only ever a real directory unless the >60% split refinement
  // bottomed out on a file with nowhere deeper to split into (`d.isFile`) —
  // only then is the trailing "/" wrong (it would glue onto the file's own
  // extension, e.g. "auth.ts/").
  const label = (d.isFile ? d.path : `${d.path}/`).padEnd(DIR_COL_WIDTH);
  const counts = `${d.files} files · ${d.symbols} symbols`;
  const hubs = d.hubs.length ? `   hubs: ${d.hubs.map(formatDirHub).join(", ")}` : "";
  return `${label}${counts}${hubs}`;
}

/** `src/graph/ → src/util/   50 edges (42 calls, 8 references)` — the arrow is
 * the direction of dependency: the left side needs the right side. */
function depPair(d: DepEdge): string {
  return `${d.fromIsFile ? d.from : `${d.from}/`} → ${d.toIsFile ? d.to : `${d.to}/`}`;
}

function formatDepLine(d: DepEdge, width: number): string {
  const breakdown = d.byRelation.map((r) => `${r.count} ${r.relation}`).join(", ");
  return `${depPair(d).padEnd(width)}${d.total} edge${d.total === 1 ? "" : "s"} (${breakdown})`;
}

function formatHotspot(h: Hub): string {
  return `${h.name} · ${h.kind} · ${h.path}:${h.span} · ${h.inDegree}←`;
}

/** The "+N more directories not shown" note, or null when nothing was dropped. */
function droppedNote(dropped: number): string | null {
  if (dropped <= 0) return null;
  return `… +${dropped} more director${dropped === 1 ? "y" : "ies"} not shown (raise max-dirs to see more)`;
}

/**
 * Render a `RepoMap` as the human report. Deterministic (same map in → same
 * string out) and targets <= 6000 chars for a typical repo (the `maxDirs`/
 * `hubsPerDir`/`hotspots` caps in `buildRepoMap` are what keep it bounded on
 * very large graphs).
 */
export function formatRepoMap(map: RepoMap): string {
  const { totals } = map;
  const header = `repo map — ${totals.files} files · ${totals.symbols} symbols · ${totals.edges} edges · ${totals.languages.join(", ")}`;

  const lines: string[] = [header, ""];
  if (map.scopes) {
    // Multi-scope: scope label as the top-level group heading, that scope's
    // own dirs listed under it — `map.dirs` is empty here, see `buildRepoMap`.
    for (const sg of map.scopes) {
      lines.push(`## ${sg.scope}`);
      for (const d of sg.dirs) lines.push(formatDirLine(d));
      const note = droppedNote(sg.dropped);
      if (note) lines.push(note);
      lines.push("");
    }
  } else {
    for (const d of map.dirs) lines.push(formatDirLine(d));
    const note = droppedNote(map.dropped);
    if (note) lines.push(note);
    lines.push("");
  }
  if (map.deps.length) {
    lines.push("depends on");
    // Padded to the widest pair actually printed, not a fixed column: directory
    // names vary wildly between repos, and a fixed width either wraps a deep
    // tree or leaves a gulf in a shallow one.
    const width = Math.max(...map.deps.map((d) => depPair(d).length)) + 3;
    for (const d of map.deps) lines.push(formatDepLine(d, width));
    if (map.depsDropped > 0) {
      lines.push(`… +${map.depsDropped} more dependenc${map.depsDropped === 1 ? "y" : "ies"} not shown (raise max-deps to see more)`);
    }
    lines.push("");
  }
  lines.push(`hotspots: ${map.hotspots.map(formatHotspot).join("  ")}`);

  const body = lines.join("\n");
  return withSavings(body, map.saved) + "\n";
}
