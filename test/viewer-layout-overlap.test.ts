/**
 * No layout may draw two nodes on top of each other.
 *
 * Every layout here places nodes by a formula, and each one of them was written
 * against a constant node size. A grouped graph is the opposite of that: one
 * bubble stands for 7,000 symbols and its neighbour for twelve, so a constant
 * slot width silently overlaps exactly the nodes a reader most wants to tell
 * apart. These tests feed each layout a deliberately lopsided set of radii and
 * check the result geometrically, which is the only check that cannot pass by
 * agreeing with the same wrong assumption the code makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { radialLayout, layeredLayout, seedPositions } from "../viewer/layouts.js";
import type { VizGraph, VizNode, VizEdge } from "../viewer/data.js";

function node(id: string, path: string): VizNode {
  return { id, name: id, type: "group", summary: "", sources: [path], path };
}

/** Radii spanning the range a real grouped graph produces: a few huge bubbles,
 * a long tail of small ones. */
function fixture(count: number): { nodes: VizNode[]; radii: Float32Array } {
  const nodes: VizNode[] = [];
  const radii = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Three directories, so the grouping layouts have real clusters to build.
    nodes.push(node(`n${i}`, `libs/mod${i % 3}/sources/file${i}.cpp`));
    radii[i] = i < 3 ? 66 : 12 + (i % 7) * 4;
  }
  return { nodes, radii };
}

function overlaps(pos: Float32Array, radii: Float32Array, nodes: VizNode[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(pos[i * 2] - pos[j * 2], pos[i * 2 + 1] - pos[j * 2 + 1]);
      if (d < radii[i] + radii[j]) bad.push(`${nodes[i].id}/${nodes[j].id} ${Math.round(d)}<${Math.round(radii[i] + radii[j])}`);
    }
  }
  return bad;
}

test("radialLayout keeps every node clear of every other, at any mix of sizes", () => {
  const { nodes, radii } = fixture(40);
  const bad = overlaps(radialLayout(nodes, 2, radii), radii, nodes);
  assert.deepEqual(bad, [], `radial layout overlaps: ${bad.slice(0, 5).join(", ")}`);
});

test("layeredLayout spaces a row by what it holds, not by a constant", () => {
  const { nodes, radii } = fixture(30);
  const edges: VizEdge[] = [];
  // A chain plus some fan-out, so the layering has more than one row to fill.
  for (let i = 1; i < nodes.length; i++) edges.push({ source: nodes[i - 1].id, target: nodes[i].id, relation: "calls" });
  for (let i = 0; i < 8; i++) edges.push({ source: nodes[0].id, target: nodes[i + 2].id, relation: "calls" });
  const graph: VizGraph = { meta: { nodeCount: nodes.length, edgeCount: edges.length }, nodes, edges };
  const bad = overlaps(layeredLayout(graph, nodes, radii), radii, nodes);
  assert.deepEqual(bad, [], `layered layout overlaps: ${bad.slice(0, 5).join(", ")}`);
});

test("the force seed starts overlap-free, so the simulation refines rather than untangles", () => {
  const { nodes, radii } = fixture(50);
  const graph: VizGraph = { meta: { nodeCount: nodes.length, edgeCount: 0 }, nodes, edges: [] };
  const bad = overlaps(seedPositions(nodes, radii, 1200, 900, graph), radii, nodes);
  assert.deepEqual(bad, [], `seed overlaps: ${bad.slice(0, 5).join(", ")}`);
});

test("one node in a group sits at its own centre rather than orbiting nothing", () => {
  // A single member used to be placed on a ring of its own, which put a lone
  // bubble at an arbitrary offset from where its label said it was.
  const nodes = [node("solo", "libs/only/sources/a.cpp")];
  const radii = Float32Array.from([40]);
  const pos = radialLayout(nodes, 2, radii);
  assert.equal(pos[0], 0);
  assert.equal(pos[1], 0);
});

test("orbitLayout nests every subtree in its own disc, without overlaps", async () => {
  const { orbitLayout } = await import("../viewer/layouts.js");
  const { nodes, radii } = fixture(45);
  // A branching tree, plus a cycle back to the root and a node nothing reaches —
  // both of which a real wiring graph always has.
  const edges: VizEdge[] = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    edges.push({ source: nodes[Math.floor((i - 1) / 3)].id, target: nodes[i].id, relation: "calls" });
  }
  edges.push({ source: nodes[9].id, target: nodes[0].id, relation: "calls" });
  const graph: VizGraph = { meta: { nodeCount: nodes.length, edgeCount: edges.length }, nodes, edges };
  const pos = orbitLayout(graph, nodes, radii, nodes[0].id)!;
  assert.ok(pos, "a rooted graph gets a layout");
  const bad = overlaps(pos, radii, nodes);
  assert.deepEqual(bad, [], `orbit layout overlaps: ${bad.slice(0, 5).join(", ")}`);
  // The unreached node is placed too, not left stacked at the origin.
  const last = nodes.length - 1;
  assert.ok(Math.hypot(pos[last * 2], pos[last * 2 + 1]) > 0, "an unreached node still gets a place");
});

test("orbitLayout puts a node's children around it, not on a shared ring", async () => {
  const { orbitLayout } = await import("../viewer/layouts.js");
  const nodes = [
    node("root", "a/root.ts"), node("p1", "a/p1.ts"), node("p2", "a/p2.ts"),
    node("c1", "a/c1.ts"), node("c2", "a/c2.ts"),
  ];
  const radii = Float32Array.from([30, 20, 20, 12, 12]);
  const edges: VizEdge[] = [
    { source: "root", target: "p1", relation: "calls" },
    { source: "root", target: "p2", relation: "calls" },
    { source: "p1", target: "c1", relation: "calls" },
    { source: "p1", target: "c2", relation: "calls" },
  ];
  const graph: VizGraph = { meta: { nodeCount: 5, edgeCount: 4 }, nodes, edges };
  const pos = orbitLayout(graph, nodes, radii, "root")!;
  const at = (id: string): [number, number] => {
    const i = nodes.findIndex((n) => n.id === id);
    return [pos[i * 2], pos[i * 2 + 1]];
  };
  const gap = (a: string, b: string): number => {
    const [ax, ay] = at(a), [bx, by] = at(b);
    return Math.hypot(ax - bx, ay - by);
  };
  // The children of p1 belong to p1: each is nearer to it than to the root, which
  // is the whole difference between this and a layout of concentric rings.
  assert.ok(gap("c1", "p1") < gap("c1", "root"), "c1 orbits p1");
  assert.ok(gap("c2", "p1") < gap("c2", "root"), "c2 orbits p1");
  // …and p2, which has no children, is not dragged into p1's cluster.
  assert.ok(gap("p2", "root") < gap("p2", "p1"), "p2 stays on the root's own ring");
});
