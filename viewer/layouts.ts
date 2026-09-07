/**
 * Layouts that are computed rather than simulated.
 *
 * Force is one answer to "where does this node go", and on a wiring graph it is
 * often the worst one: it optimises for pretty spacing, which is not a property
 * anybody wants to read off a dependency graph. Two structural alternatives, both
 * O(V+E) and both exact — no ticks, no settling, no worker:
 *
 *   radial   one ring per directory, so the picture matches the tree on disk
 *   layered  depth from the roots on Y, so an arrow down the page means "depends on"
 *
 * Each returns the same flat `[x0,y0,x1,y1,…]` buffer the force layout produces,
 * so the renderer and the driver treat all three identically.
 */
import type { VizGraph, VizNode } from "./data.js";
import { pathOf, significantDirs } from "./aggregate.js";

export type LayoutMode = "tree" | "force" | "radial" | "layered";

/** Comfortable spacing in world units; the view fits itself to whatever comes out. */
const LAYER_GAP = 220;
const NODE_GAP = 70;

/**
 * How much of a disc its contents are allowed to occupy.
 *
 * Everything below sizes discs from the AREA of what goes in them rather than
 * from a constant, which is the whole difference between a seed that is already
 * roughly right and one the forces have to spend their entire run untangling.
 * A quarter full looks generously spaced; a half-full outer disc keeps the whole
 * graph compact enough to read.
 */
const INNER_FILL = 0.25;
const OUTER_FILL = 0.5;

/** Directory depth used to cluster loose symbols when seeding. Two levels is what
 * the aggregation view defaults to, so a seeded graph and a grouped one put the
 * same things in the same place. */
const SEED_DEPTH = 2;

/** Gap between neighbours on a ring, and between rings, in world units. */
const RING_PAD = 26;

/** The golden angle. Successive points at this angle never line up into spokes,
 * which is what makes a sunflower spiral look evenly filled at any count. */
const GOLDEN_ANGLE = 2.39996323;

/** Radius a disc needs to hold circles of these radii at `fill` density. */
function discRadius(radii: number[], fill: number): number {
  let area = 0;
  for (const r of radii) area += r * r; // the pi cancels against the disc's own
  return Math.sqrt(area / fill);
}

/** Points spread evenly over a disc of radius `R`, densest-packing-first. */
function sunflower(i: number, count: number, R: number): [number, number] {
  const a = i * GOLDEN_ANGLE;
  // sqrt keeps the density uniform; without it everything piles at the centre.
  const r = R * Math.sqrt((i + 0.5) / count);
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** Which cluster a node seeds into: a rolled-up bubble is its own, a loose symbol
 * joins its directory. */
function clusterKeyOf(node: VizNode): string {
  if (node.type === "group") return node.path ?? node.id;
  return significantDirs(pathOf(node)).slice(0, SEED_DEPTH).join("/") || "·";
}

/**
 * File names that conventionally hold a program's entry point.
 *
 * Language-general by listing conventions rather than by knowing languages: a
 * repo whose entry point is called something else simply falls through to the
 * degree heuristic below, which is the same answer this would have given anyway.
 */
const ENTRY_FILES = [
  /^main\.[a-z]+$/, /^index\.[a-z]+$/, /^app\.[a-z]+$/, /^cli\.[a-z]+$/,
  /^__main__\.py$/, /^program\.cs$/, /^lib\.rs$/, /^mod\.rs$/, /^server\.[a-z]+$/,
];

/**
 * The node the picture should be built around.
 *
 * A graph laid out from nowhere in particular reads as an explosion; laid out
 * from its entry point it reads as a program. Three rules, in order:
 *
 *  1. A rolled-up view has no `main.cpp` to find — its nodes are directories — so
 *     the repo's own root group wins, which is exactly where an entry point lives.
 *  2. Otherwise, a file named by convention, shallowest first: a `main.c` at the
 *     top of the tree outranks one inside a vendored dependency.
 *  3. Otherwise, whatever depends on the most things. Not the most connected —
 *     the most OUTGOING — because a utility everything calls is the bottom of the
 *     graph, and the root of a program is at the top.
 */
export function findRoot(graph: VizGraph): string | null {
  if (graph.nodes.length === 0) return null;
  const out = new Map<string, number>();
  for (const e of graph.edges) out.set(e.source, (out.get(e.source) ?? 0) + 1);

  const groups = graph.nodes.filter((n) => n.type === "group");
  if (groups.length > 0) {
    const root = groups.find((n) => n.path === "");
    if (root) return root.id;
    return groups.reduce((best, n) => ((out.get(n.id) ?? 0) > (out.get(best.id) ?? 0) ? n : best)).id;
  }

  const entries = graph.nodes
    .filter((n) => ENTRY_FILES.some((re) => re.test((pathOf(n).split("/").pop() ?? "").toLowerCase())))
    .sort((a, b) => pathOf(a).split("/").length - pathOf(b).split("/").length);
  if (entries.length > 0) return entries[0].id;

  let best: string | null = null;
  for (const n of graph.nodes) {
    if (best === null || (out.get(n.id) ?? 0) > (out.get(best) ?? 0)) best = n.id;
  }
  return (out.get(best ?? "") ?? 0) > 0 ? best : null;
}

/**
 * Concentric rings by dependency depth, rooted at the entry point.
 *
 * Ring 0 is the root; ring N is everything first reached in N steps. Each node is
 * placed near the angle of whatever reached it, so a subtree stays a wedge rather
 * than being scattered around the circle, and edges run outward instead of
 * crossing the middle. Rings are sized from what they must hold, so a wide layer
 * gets a wide ring instead of a crowded one.
 *
 * Direction matters: the walk follows outgoing edges first, so distance from the
 * centre means "how far below the entry point", not merely "how far away".
 * Anything the entry point cannot reach is walked undirected afterwards, and
 * whatever is still unreached — half a wiring graph, typically — rings the
 * outside, clustered by directory so it is at least ordered.
 */
export function radialTreeSeed(
  graph: VizGraph, radii: Float32Array, width: number, height: number, rootId: string,
): Float32Array | null {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const root = index.get(rootId);
  if (root === undefined) return null;

  const out: number[][] = graph.nodes.map(() => []);
  const both: number[][] = graph.nodes.map(() => []);
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    out[a].push(b);
    both[a].push(b);
    both[b].push(a);
  }

  const depth = new Int32Array(graph.nodes.length).fill(-1);
  const layers: number[][] = [[root]];
  depth[root] = 0;
  const walk = (adjacency: number[][]): void => {
    for (let d = 0; d < layers.length; d++) {
      const next: number[] = [];
      for (const n of layers[d]) {
        for (const m of adjacency[n]) {
          if (depth[m] !== -1) continue;
          depth[m] = d + 1;
          next.push(m);
        }
      }
      if (next.length === 0) continue;
      if (layers[d + 1]) layers[d + 1].push(...next);
      else layers[d + 1] = next;
    }
  };
  walk(out);   // dependency depth first…
  walk(both);  // …then anything only reachable the other way round

  const unreached = [];
  for (let i = 0; i < graph.nodes.length; i++) if (depth[i] === -1) unreached.push(i);
  if (unreached.length > 0) layers.push(unreached);

  const positions = new Float32Array(graph.nodes.length * 2);
  const cx = width / 2;
  const cy = height / 2;
  positions[root * 2] = cx;
  positions[root * 2 + 1] = cy;

  const angleOf = new Float64Array(graph.nodes.length);
  let previousRadius = radii[root];
  for (let d = 1; d < layers.length; d++) {
    const ring = layers[d];
    // Siblings from the same parent stay together, and within that, same-module
    // nodes stay together — so a ring reads as bands rather than confetti.
    ring.sort((a, b) => angleOf[a] - angleOf[b] || clusterKeyOf(graph.nodes[a]).localeCompare(clusterKeyOf(graph.nodes[b])));
    const need = ring.reduce((sum, i) => sum + (radii[i] + RING_PAD) * 2, 0);
    const radius = Math.max(previousRadius + RING_PAD * 4, need / (Math.PI * 2));
    let walked = 0;
    for (const i of ring) {
      const w = (radii[i] + RING_PAD) * 2;
      const angle = ((walked + w / 2) / need) * Math.PI * 2;
      walked += w;
      angleOf[i] = angle;
      positions[i * 2] = cx + Math.cos(angle) * radius;
      positions[i * 2 + 1] = cy + Math.sin(angle) * radius;
    }
    previousRadius = radius + Math.max(...ring.map((i) => radii[i]));
  }
  return positions;
}

/**
 * Starting positions: clustered by directory, spread by how much has to fit.
 *
 * A force layout is largely decided by where it starts. Seeding every node on one
 * disc of a fixed size put 26,000 symbols — or 66 module bubbles whose radii run
 * to 60 units — inside a few hundred units of each other, so the run began as one
 * solid pile and spent itself pushing outward instead of arranging anything. Worse,
 * a blind seed scatters each directory's symbols across the whole disc, and no
 * amount of simulation brings them back together: the links that would pull them
 * are outnumbered by the repulsion that will not.
 *
 * So the seed does the organising, and the forces refine it. Every disc — each
 * cluster, and the disc of clusters — is sized from the area of its contents, so
 * the arrangement is equally spaced whether it holds twelve nodes or twelve
 * thousand.
 */
export function seedPositions(
  nodes: VizNode[], radii: Float32Array, width: number, height: number, graph?: VizGraph,
): Float32Array {
  const out = new Float32Array(nodes.length * 2);
  if (nodes.length === 0) return out;

  // Prefer a tree rooted at the entry point: same spacing rules, but the picture
  // starts out saying something rather than merely being evenly spread.
  if (graph) {
    const rootId = findRoot(graph);
    const tree = rootId ? radialTreeSeed(graph, radii, width, height, rootId) : null;
    if (tree) return tree;
  }

  const clusters = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const key = clusterKeyOf(nodes[i]);
    const c = clusters.get(key);
    if (c) c.push(i);
    else clusters.set(key, [i]);
  }

  // Biggest first, so the largest clusters take the middle and the long tail of
  // one-file directories rings the outside instead of splitting the core.
  const keys = [...clusters.keys()].sort(
    (a, b) => clusters.get(b)!.length - clusters.get(a)!.length || a.localeCompare(b),
  );
  const clusterRadius = new Map<string, number>();
  for (const key of keys) {
    clusterRadius.set(key, discRadius(clusters.get(key)!.map((i) => radii[i]), INNER_FILL));
  }
  const outer = discRadius([...clusterRadius.values()], OUTER_FILL);

  const cx = width / 2;
  const cy = height / 2;
  keys.forEach((key, gi) => {
    const [gx, gy] = keys.length === 1 ? [0, 0] : sunflower(gi, keys.length, outer);
    const members = clusters.get(key)!;
    const R = clusterRadius.get(key)!;
    members.forEach((idx, j) => {
      const [mx, my] = members.length === 1 ? [0, 0] : sunflower(j, members.length, R);
      out[idx * 2] = cx + gx + mx;
      out[idx * 2 + 1] = cy + gy + my;
    });
  });
  return out;
}

/**
 * One ring per directory, rings laid out around a larger circle.
 *
 * The grouping is the same one the aggregation view uses, so switching between
 * "grouped" and "radial, ungrouped" keeps things in the same place on screen —
 * a directory that was a bubble becomes a ring where the bubble was.
 */
export function radialLayout(nodes: VizNode[], depth = 2): Float32Array {
  const groups = new Map<string, VizNode[]>();
  for (const n of nodes) {
    const key = significantDirs(pathOf(n)).slice(0, depth).join("/") || "·";
    const g = groups.get(key);
    if (g) g.push(n);
    else groups.set(key, [n]);
  }

  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const out = new Float32Array(nodes.length * 2);
  const keys = [...groups.keys()].sort();

  // Each ring's radius is whatever its own members need at NODE_GAP spacing, and
  // the circle the rings sit on is big enough for the largest of them — so one
  // 1,200-symbol directory can no longer swallow its neighbours.
  const ringRadius = new Map<string, number>();
  for (const key of keys) {
    ringRadius.set(key, Math.max(NODE_GAP, (groups.get(key)!.length * NODE_GAP) / (Math.PI * 2)));
  }
  const widest = Math.max(...ringRadius.values());
  const outer = Math.max(widest * 2, (keys.length * widest * 2.2) / (Math.PI * 2));

  keys.forEach((key, gi) => {
    const members = groups.get(key)!;
    const angle = (gi / keys.length) * Math.PI * 2;
    const cx = Math.cos(angle) * outer;
    const cy = Math.sin(angle) * outer;
    const r = ringRadius.get(key)!;
    members.forEach((n, i) => {
      const a = (i / members.length) * Math.PI * 2;
      const at = order.get(n.id)!;
      out[at * 2] = cx + Math.cos(a) * r;
      out[at * 2 + 1] = cy + Math.sin(a) * r;
    });
  });
  return out;
}

/**
 * Longest-path layering: Y is how deep a symbol sits below the roots.
 *
 * Cycles are broken by refusing to revisit a node already on the current walk —
 * a back edge simply does not extend the depth. A real codebase always has some,
 * and a layout that throws on them is a layout nobody can use; the cycle itself
 * is reported properly by `findCycles` in ./analysis.ts, which is where that
 * belongs.
 */
export function layeredLayout(graph: VizGraph, nodes: VizNode[]): Float32Array {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const incoming: number[][] = nodes.map(() => []);
  for (const e of graph.edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    incoming[t].push(s);
  }

  // Iterative longest-path with an explicit stack and a three-state mark, so a
  // 20k-deep chain cannot overflow and a cycle cannot loop forever.
  const depth = new Int32Array(nodes.length).fill(-1);
  const state = new Uint8Array(nodes.length); // 0 unvisited · 1 in progress · 2 done
  for (let root = 0; root < nodes.length; root++) {
    if (state[root] === 2) continue;
    const stack = [root];
    while (stack.length) {
      const v = stack[stack.length - 1];
      if (state[v] === 0) state[v] = 1;
      let pending = -1;
      for (const p of incoming[v]) {
        if (state[p] === 0) { pending = p; break; }
      }
      if (pending !== -1) { stack.push(pending); continue; }
      let d = 0;
      for (const p of incoming[v]) {
        // `state[p] === 1` is a back edge into the current walk: ignore it rather
        // than let it define a depth that depends on where the walk started.
        if (state[p] === 2 && depth[p] + 1 > d) d = depth[p] + 1;
      }
      depth[v] = d;
      state[v] = 2;
      stack.pop();
    }
  }

  const perLayer = new Map<number, number>();
  const out = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    const layer = depth[i];
    const slot = perLayer.get(layer) ?? 0;
    perLayer.set(layer, slot + 1);
    out[i * 2] = slot * NODE_GAP;
    out[i * 2 + 1] = layer * LAYER_GAP;
  }
  // Centre each layer on x=0 so the result reads as a tree rather than a staircase.
  const widths = new Map([...perLayer].map(([layer, n]) => [layer, ((n - 1) * NODE_GAP) / 2]));
  for (let i = 0; i < nodes.length; i++) out[i * 2] -= widths.get(depth[i]) ?? 0;
  return out;
}

/**
 * Positions for a non-force mode, or null for force (which the worker owns).
 *
 * `tree` is also what seeds the force layout, but as a mode it is kept exactly:
 * a force pass spends its whole run trading the ordering away for even spacing,
 * so a reader who wants the ordering has to be able to say so and keep it.
 */
export function staticLayout(
  mode: LayoutMode, graph: VizGraph, depth: number, radii: Float32Array,
): Float32Array | null {
  if (mode === "radial") return radialLayout(graph.nodes, Math.max(1, depth || 2));
  if (mode === "layered") return layeredLayout(graph, graph.nodes);
  if (mode === "tree") {
    const root = findRoot(graph);
    return root ? radialTreeSeed(graph, radii, 1200, 900, root) : null;
  }
  return null;
}
