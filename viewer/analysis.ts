/**
 * Graph questions the picture alone cannot answer.
 *
 * A force layout shows you that two things are near each other, which is not the
 * same as showing you that one depends on the other, or that eleven modules are
 * stuck in a dependency cycle, or which four symbols hold the whole thing
 * together. Each function here answers one such question and returns a plain set
 * or list of ids — the renderer paints whatever it is handed and knows nothing
 * about why.
 *
 * All of it runs over an adjacency index built once per dataset, so a 26k-node
 * graph answers in single-digit milliseconds and the UI can do it on a click.
 */
import type { VizGraph } from "./data.js";

export interface Adjacency {
  /** Ids in a stable order; every index below refers to this. */
  ids: string[];
  index: Map<string, number>;
  /** Outgoing and incoming neighbours per node. */
  out: number[][];
  in: number[][];
}

export function buildAdjacency(graph: VizGraph): Adjacency {
  const ids = graph.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const out: number[][] = ids.map(() => []);
  const inn: number[][] = ids.map(() => []);
  for (const e of graph.edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    out[s].push(t);
    inn[t].push(s);
  }
  return { ids, index, out, in: inn };
}

/**
 * The shortest dependency path between two symbols, as ids including both ends.
 *
 * Breadth-first over directed edges: "how does A reach B" has a different answer
 * from "how does B reach A", and collapsing the two would make the result a lie
 * in a graph whose entire meaning is direction. Empty when B is unreachable.
 */
export function shortestPath(adj: Adjacency, fromId: string, toId: string): string[] {
  const from = adj.index.get(fromId);
  const to = adj.index.get(toId);
  if (from === undefined || to === undefined) return [];
  if (from === to) return [fromId];
  const prev = new Int32Array(adj.ids.length).fill(-1);
  const seen = new Uint8Array(adj.ids.length);
  seen[from] = 1;
  let frontier = [from];
  while (frontier.length) {
    const next: number[] = [];
    for (const n of frontier) {
      for (const m of adj.out[n]) {
        if (seen[m]) continue;
        seen[m] = 1;
        prev[m] = n;
        if (m === to) {
          const path: string[] = [];
          for (let at = to; at !== -1; at = prev[at]) path.push(adj.ids[at]);
          return path.reverse();
        }
        next.push(m);
      }
    }
    frontier = next;
  }
  return [];
}

/**
 * Everything within `hops` of a symbol, in either direction.
 *
 * Undirected on purpose, unlike {@link shortestPath}: a lens is for "show me this
 * thing and what it touches", and the callers of a function are as much its
 * neighbourhood as its callees.
 */
export function neighborhood(adj: Adjacency, id: string, hops: number): Set<string> {
  const start = adj.index.get(id);
  const found = new Set<string>();
  if (start === undefined) return found;
  const seen = new Uint8Array(adj.ids.length);
  seen[start] = 1;
  found.add(id);
  let frontier = [start];
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: number[] = [];
    for (const n of frontier) {
      for (const m of [...adj.out[n], ...adj.in[n]]) {
        if (seen[m]) continue;
        seen[m] = 1;
        found.add(adj.ids[m]);
        next.push(m);
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Strongly connected components of size > 1 — the dependency cycles.
 *
 * Tarjan, written iteratively rather than recursively: a 26k-node graph in a
 * C++ tree reaches call depths that blow a JavaScript stack, and a crash in a
 * "show me the cycles" button is a worse answer than a slow one.
 *
 * Returned largest first, because the biggest tangle is the one worth breaking.
 */
export function findCycles(adj: Adjacency): string[][] {
  const n = adj.ids.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const out: string[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    // Each frame is (node, how many of its successors we have already walked).
    const work: Array<[number, number]> = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame[0];
      if (frame[1] === 0) {
        index[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = 1;
      }
      let descended = false;
      while (frame[1] < adj.out[v].length) {
        const w = adj.out[v][frame[1]++];
        if (index[w] === -1) {
          work.push([w, 0]);
          descended = true;
          break;
        }
        if (onStack[w] && index[w] < low[v]) low[v] = index[w];
      }
      if (descended) continue;
      if (low[v] === index[v]) {
        const component: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = 0;
          component.push(adj.ids[w]);
          if (w === v) break;
        }
        if (component.length > 1) out.push(component);
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent && low[v] < low[parent[0]]) low[parent[0]] = low[v];
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * The most connected symbols, most first.
 *
 * Degree, not betweenness. Betweenness is the textbook centrality and it is
 * O(V·E) — twenty minutes on a graph this size, for a ranking that in practice
 * puts the same handful of god-objects on top as counting edges does.
 */
export function hubs(adj: Adjacency, limit = 20): Array<{ id: string; degree: number }> {
  return adj.ids
    .map((id, i) => ({ id, degree: adj.out[i].length + adj.in[i].length }))
    .filter((h) => h.degree > 0)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
}
