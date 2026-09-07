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
import { pathOf } from "./aggregate.js";

export type LayoutMode = "force" | "radial" | "layered";

/** Comfortable spacing in world units; the view fits itself to whatever comes out. */
const RING_GAP = 240;
const LAYER_GAP = 220;
const NODE_GAP = 70;

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
    const dirs = pathOf(n).split("/").slice(0, -1);
    const key = dirs.slice(0, depth).join("/") || "·";
    const g = groups.get(key);
    if (g) g.push(n);
    else groups.set(key, [n]);
  }

  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const out = new Float32Array(nodes.length * 2);
  const keys = [...groups.keys()].sort();
  // Ring radius grows with the square root of the group count so the outer ring
  // does not run away from the centre on a repo with many directories.
  const outer = RING_GAP * Math.sqrt(keys.length);

  keys.forEach((key, gi) => {
    const members = groups.get(key)!;
    const angle = (gi / keys.length) * Math.PI * 2;
    const cx = Math.cos(angle) * outer;
    const cy = Math.sin(angle) * outer;
    // Circumference has to fit every member at NODE_GAP spacing, or a 1200-symbol
    // directory becomes a solid disc.
    const r = Math.max(NODE_GAP, (members.length * NODE_GAP) / (Math.PI * 2));
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

/** Positions for a non-force mode, or null for force (which the worker owns). */
export function staticLayout(mode: LayoutMode, graph: VizGraph, depth: number): Float32Array | null {
  if (mode === "radial") return radialLayout(graph.nodes, Math.max(1, depth || 2));
  if (mode === "layered") return layeredLayout(graph, graph.nodes);
  return null;
}
