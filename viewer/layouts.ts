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

export type LayoutMode = "tree" | "orbit" | "force" | "radial" | "layered";

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

/** Breathing room around each subtree disc, and how much of the circle a node's
 * children may use — the rest is left facing its own parent, so a ring never
 * closes over the branch it grew from. */
const ORBIT_PAD = 9;
/**
 * Half the circle, so a node's descendants stay strictly on the far side of it
 * from its own parent.
 *
 * Wider looks airier and costs far more than it looks: at 1.55π a subtree wraps
 * back past its parent, so every ring had to clear the whole of the widest
 * child's subtree — a cost that compounds at each level, and put nodes 6,700
 * units from the root on one real repo. Confined to a half-plane, a ring only has
 * to clear the child ITSELF, and depth stops multiplying.
 */
const ORBIT_SPAN = Math.PI;

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
  // Clusters are placed by PACKING, not by spreading points evenly: a sunflower
  // assumes every point is the same size, and a grouped graph is the opposite of
  // that — one 7,000-symbol bubble beside forty small ones. Sized discs laid on
  // the spiral in descending order start out touching instead of overlapping,
  // which is the difference between a picture that is readable on arrival and one
  // the forces have to unpile first.
  const placed = packDiscs(keys.map((k) => clusterRadius.get(k)! + RING_PAD), outer);
  keys.forEach((key, gi) => {
    const [gx, gy] = placed[gi];
    const members = clusters.get(key)!;
    const R = clusterRadius.get(key)!;
    const inner = packDiscs(members.map((i) => radii[i] + RING_PAD / 2), R);
    members.forEach((idx, j) => {
      const [mx, my] = inner[j];
      out[idx * 2] = cx + gx + mx;
      out[idx * 2 + 1] = cy + gy + my;
    });
  });
  return out;
}

/**
 * Lay out discs of the given radii around the origin so that none overlaps.
 *
 * Biggest first onto an Archimedean spiral, each one advanced until it clears
 * everything already placed. Greedy and O(n·k) with a small k because the spiral
 * only ever has to step past the neighbours it just laid down — and unlike a
 * density formula it is *checked*, so the guarantee holds for any mix of sizes
 * rather than on average.
 *
 * `hint` only sets the spiral's pitch: the result grows to whatever the contents
 * actually need.
 */
function packDiscs(radii: number[], hint: number): [number, number][] {
  const order = radii.map((r, i) => i).sort((a, b) => radii[b] - radii[a]);
  const out: [number, number][] = radii.map(() => [0, 0]);
  const done: { x: number; y: number; r: number }[] = [];
  // Pitch: how much the spiral's radius grows per turn. Tied to the typical disc
  // so a crowd of equal circles lands on neat rings.
  const pitch = Math.max(hint / 6, Math.max(...radii, 1) * 1.6);

  for (const i of order) {
    const r = radii[i];
    if (done.length === 0) { out[i] = [0, 0]; done.push({ x: 0, y: 0, r }); continue; }
    let angle = done.length * GOLDEN_ANGLE;
    let placed = false;
    // Walk outward along the spiral until the disc fits. The bound is generous
    // and never reached in practice; it exists so a pathological input degrades
    // to "slightly overlapping" rather than to a hung frame.
    for (let step = 0; step < 4000 && !placed; step++) {
      angle += 0.35;
      const radius = (pitch * angle) / (Math.PI * 2);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      let clear = true;
      for (const d of done) {
        const dx = x - d.x, dy = y - d.y;
        if (dx * dx + dy * dy < (r + d.r) * (r + d.r)) { clear = false; break; }
      }
      if (clear) { out[i] = [x, y]; done.push({ x, y, r }); placed = true; }
    }
    if (!placed) {
      const radius = (pitch * angle) / (Math.PI * 2);
      out[i] = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      done.push({ x: out[i][0], y: out[i][1], r });
    }
  }
  return out;
}

/**
 * One ring per directory, rings laid out around a larger circle.
 *
 * The grouping is the same one the aggregation view uses, so switching between
 * "grouped" and "radial, ungrouped" keeps things in the same place on screen —
 * a directory that was a bubble becomes a ring where the bubble was.
 */
export function radialLayout(nodes: VizNode[], depth = 2, radii?: Float32Array): Float32Array {
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

  // Every distance here is measured in the space a node actually occupies. A
  // constant slot width assumes every node is the same size, and on a grouped
  // graph — where one bubble stands for 7,000 symbols and its neighbour for
  // twelve — that assumption is how two rings ended up drawn through each other.
  const roomOf = (n: VizNode): number => (radii ? radii[order.get(n.id)!] : NODE_GAP / 2);
  const slot = (n: VizNode): number => (roomOf(n) + RING_PAD) * 2;

  const ringRadius = new Map<string, number>();
  for (const key of keys) {
    const members = groups.get(key)!;
    const need = members.reduce((sum, n) => sum + slot(n), 0);
    const widestMember = Math.max(...members.map(roomOf));
    // One member sits at the centre of its own ring; two or more need a circle
    // whose circumference holds them all side by side.
    ringRadius.set(key, members.length === 1 ? 0 : Math.max(widestMember, need / (Math.PI * 2)));
  }
  // Each ring's own footprint is its radius plus its biggest member, so the rings
  // are packed as discs of that size rather than as points on a circle.
  const footprint = keys.map((key) =>
    ringRadius.get(key)! + Math.max(...groups.get(key)!.map(roomOf)) + RING_PAD);
  const centres = packDiscs(footprint, Math.max(...footprint) * 4);

  keys.forEach((key, gi) => {
    const members = groups.get(key)!;
    const [cx, cy] = centres[gi];
    const r = ringRadius.get(key)!;
    const need = members.reduce((sum, n) => sum + slot(n), 0);
    let walked = 0;
    members.forEach((n) => {
      const a = ((walked + slot(n) / 2) / need) * Math.PI * 2;
      walked += slot(n);
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
export function layeredLayout(graph: VizGraph, nodes: VizNode[], radii?: Float32Array): Float32Array {
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

  // Walk each layer along X by what its nodes actually occupy, not by a constant
  // slot: a rolled-up bubble is several times the width of a lone function, and a
  // fixed pitch overlaps them for exactly the nodes that matter most.
  const room = (i: number): number => (radii ? radii[i] : NODE_GAP / 2);
  const perLayer = new Map<number, number>();
  const out = new Float32Array(nodes.length * 2);
  const rowHeight = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const layer = depth[i];
    const walked = perLayer.get(layer) ?? 0;
    const w = (room(i) + RING_PAD) * 2;
    perLayer.set(layer, walked + w);
    rowHeight.set(layer, Math.max(rowHeight.get(layer) ?? 0, room(i)));
    out[i * 2] = walked + w / 2;
    out[i * 2 + 1] = layer;
  }
  // Rows are stacked by what they hold, so a row of big bubbles cannot run into
  // the row beneath it. The first row still sits at y=0: depth is the thing this
  // layout exists to show, and "the roots are at zero" is what makes a Y
  // coordinate readable as a depth at all.
  const rowY = new Map<number, number>();
  let y = 0;
  let previousHeight = 0;
  for (const layer of [...rowHeight.keys()].sort((a, b) => a - b)) {
    const h = rowHeight.get(layer)!;
    if (rowY.size > 0) y += previousHeight + h + LAYER_GAP;
    rowY.set(layer, y);
    previousHeight = h;
  }
  for (let i = 0; i < nodes.length; i++) out[i * 2 + 1] = rowY.get(depth[i]) ?? 0;
  // Centre each layer on x=0 so the result reads as a tree rather than a staircase.
  const widths = new Map([...perLayer].map(([layer, w]) => [layer, w / 2]));
  for (let i = 0; i < nodes.length; i++) out[i * 2] -= widths.get(depth[i]) ?? 0;
  return out;
}

/**
 * A tree of circles: every node's children ring the node itself, recursively.
 *
 * `tree` puts each BFS level on one global circle, which answers "how far is this
 * from the entry point" and nothing else — at depth three, forty nodes from a
 * dozen unrelated parents are interleaved on the same ring and no subtree reads
 * as a thing. Here each node owns a disc: its children sit on a ring around IT,
 * and each of those children owns a smaller disc of its own, all the way down. A
 * subtree is then a shape you can point at, and its size on screen is how much
 * hangs off it.
 *
 * Non-overlap is by construction rather than by tuning. Every subtree is measured
 * bottom-up as a disc, and siblings are placed on a circle whose circumference
 * holds those discs side by side — an arc is never shorter than the chord it
 * subtends, so discs that fit around the circle cannot reach each other. The
 * wedge facing a node's own parent is left empty, so a child ring never closes
 * over the branch it grew from.
 */
export function orbitLayout(
  graph: VizGraph, nodes: VizNode[], radii: Float32Array, rootId: string,
): Float32Array | null {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const root = index.get(rootId);
  if (root === undefined) return null;

  // The spanning tree: outgoing edges first, so "what this depends on" is what
  // hangs below a node wherever the graph allows a choice.
  const out: number[][] = nodes.map(() => []);
  const both: number[][] = nodes.map(() => []);
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    out[a].push(b);
    both[a].push(b);
    both[b].push(a);
  }
  const kids: number[][] = nodes.map(() => []);
  const seen = new Uint8Array(nodes.length);
  seen[root] = 1;
  const grow = (adjacency: number[][]): void => {
    let frontier = [root];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const v of frontier) {
        for (const w of adjacency[v]) {
          if (seen[w]) continue;
          seen[w] = 1;
          kids[v].push(w);
          next.push(w);
        }
      }
      frontier = next;
    }
  };
  grow(out);
  grow(both);

  // Anything the edges never reach is still part of the picture: hang it off the
  // root rather than leaving it stacked at the origin.
  const orphans: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (!seen[i]) { seen[i] = 1; orphans.push(i); }
  kids[root].push(...orphans);

  const room = (i: number): number => radii[i];
  // Bottom-up: the radius of the disc each subtree needs, and the ring its own
  // children sit on. Iterative post-order — a deep chain must not blow the stack.
  const disc = new Float64Array(nodes.length);
  const ring = new Float64Array(nodes.length);
  const order: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const v = stack.pop()!;
    order.push(v);
    for (const w of kids[v]) stack.push(w);
  }
  // One ring per node, with each child given the ARC its whole subtree needs but
  // placed at a radius that only has to clear the child ITSELF.
  //
  // Those are two different quantities and conflating them is what made this
  // sprawl: sizing the radius by the widest child's entire subtree compounded at
  // every level and threw nodes 6,700 units out on a real repo. Sizing the arc by
  // the subtree is what stops two siblings' descendants meeting, so that part
  // stays. Splitting leaves onto a ring of their own was tried and is worse: a
  // leaf then sits directly under a branch sibling and reads as belonging to it.
  const widthOf = (i: number): number => ((kids[i].length === 0 ? room(i) : disc[i]) + ORBIT_PAD) * 2;

  for (let k = order.length - 1; k >= 0; k--) {
    const v = order[k];
    if (kids[v].length === 0) { disc[v] = room(v); continue; }
    const span = v === root ? Math.PI * 2 : ORBIT_SPAN;
    let need = 0;
    let widestNode = 0;
    let widestDisc = 0;
    for (const w of kids[v]) {
      need += widthOf(w);
      widestNode = Math.max(widestNode, room(w));
      widestDisc = Math.max(widestDisc, disc[w]);
    }
    ring[v] = Math.max(room(v) + widestNode + ORBIT_PAD, need / span);
    // The disc is what the GRANDPARENT budgets arc for, so it stays the honest
    // outer extent: the ring plus the largest subtree hanging off it.
    disc[v] = ring[v] + widestDisc + ORBIT_PAD;
  }

  const pos = new Float32Array(nodes.length * 2);
  // Iterative pre-order placement, each node told which way its parent lies so it
  // can grow away from it.
  const work: { v: number; x: number; y: number; away: number }[] = [{ v: root, x: 0, y: 0, away: 0 }];
  while (work.length > 0) {
    const { v, x, y, away } = work.pop()!;
    pos[v * 2] = x;
    pos[v * 2 + 1] = y;
    if (kids[v].length === 0) continue;
    const span = v === root ? Math.PI * 2 : ORBIT_SPAN;
    const need = kids[v].reduce((n, w) => n + widthOf(w), 0);
    // Biggest subtree in the middle of the wedge, the rest alternating outward, so
    // a node's weight sits under it rather than trailing off one side. Ties break
    // on discovery order, so two runs of the same repo draw the same picture.
    const bySize = [...kids[v]].sort((a, b) => widthOf(b) - widthOf(a));
    const balanced: number[] = [];
    bySize.forEach((w, i) => (i % 2 === 0 ? balanced.push(w) : balanced.unshift(w)));
    let walked = 0;
    for (const w of balanced) {
      const width = widthOf(w);
      const angle = away - span / 2 + ((walked + width / 2) / need) * span;
      walked += width;
      work.push({ v: w, x: x + Math.cos(angle) * ring[v], y: y + Math.sin(angle) * ring[v], away: angle });
    }
  }
  return pos;
}

/**
 * Positions for a non-force mode, or null for force (which the worker owns).
 *
 * `tree` is also what seeds the force layout, but as a mode it is kept exactly:
 * a force pass spends its whole run trading the ordering away for even spacing,
 * so a reader who wants the ordering has to be able to say so and keep it.
 */
export function staticLayout(
  mode: LayoutMode, graph: VizGraph, depth: number, radii: Float32Array, orbitRoot?: string,
): Float32Array | null {
  if (mode === "orbit") {
    // Whatever the reader ctrl-clicked, if it is still on screen: re-rooting is
    // the whole point of the mode, and falling back to the entry point silently
    // would answer a different question than the one they asked.
    const root = (orbitRoot && graph.nodes.some((n) => n.id === orbitRoot) ? orbitRoot : null) ?? findRoot(graph);
    return root ? orbitLayout(graph, graph.nodes, radii, root) : null;
  }
  if (mode === "radial") return radialLayout(graph.nodes, Math.max(1, depth || 2), radii);
  if (mode === "layered") return layeredLayout(graph, graph.nodes, radii);
  if (mode === "tree") {
    const root = findRoot(graph);
    return root ? radialTreeSeed(graph, radii, 1200, 900, root) : null;
  }
  return null;
}
