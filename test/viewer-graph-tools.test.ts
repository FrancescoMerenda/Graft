/**
 * The viewer's two pure graph modules: rolling a graph up by directory
 * (`viewer/aggregate.ts`) and answering questions about it (`viewer/analysis.ts`).
 *
 * Both are deliberately DOM-free so they can be tested here rather than through a
 * browser — which is also why the renderer knows nothing about either of them: it
 * draws whatever nodes and edges it is handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupGraph, groupKeyOf, availableDepths, pathOf } from "../viewer/aggregate.js";
import { buildAdjacency, shortestPath, neighborhood, findCycles, hubs } from "../viewer/analysis.js";
import type { VizGraph, VizNode, VizEdge } from "../viewer/data.js";

function node(id: string, path: string): VizNode {
  return { id, name: id.split("#").pop() ?? id, type: "function", summary: "", sources: [], path };
}
function edge(source: string, target: string, relation = "calls"): VizEdge {
  return { source, target, relation };
}

/** Two modules that reference each other, one lone file, one orphan symbol. */
const GRAPH: VizGraph = {
  meta: { nodeCount: 0, edgeCount: 0 },
  nodes: [
    node("libs/mcl/a.cpp#Ua.start", "libs/mcl/a.cpp"),
    node("libs/mcl/a.cpp#Ua.stop", "libs/mcl/a.cpp"),
    node("libs/mcl/b.cpp#helper", "libs/mcl/b.cpp"),
    node("libs/sip/s.cpp#Registrar.bind", "libs/sip/s.cpp"),
    node("libs/sip/s.cpp#Registrar.drop", "libs/sip/s.cpp"),
    node("main.cpp#main", "main.cpp"),
    node("libs/mcl/a.cpp#Unused.never", "libs/mcl/a.cpp"),
  ],
  edges: [
    edge("libs/mcl/a.cpp#Ua.start", "libs/mcl/b.cpp#helper"),      // inside mcl
    edge("libs/mcl/a.cpp#Ua.start", "libs/sip/s.cpp#Registrar.bind"), // mcl → sip
    edge("libs/mcl/a.cpp#Ua.stop", "libs/sip/s.cpp#Registrar.bind"),  // mcl → sip
    edge("libs/sip/s.cpp#Registrar.drop", "libs/mcl/a.cpp#Ua.stop"),  // sip → mcl
    edge("libs/sip/s.cpp#Registrar.bind", "libs/mcl/a.cpp#Ua.start"), // …and back: a cycle
    edge("main.cpp#main", "libs/mcl/a.cpp#Ua.start"),
  ],
};

/* ---------------------------------------------------------------- aggregate -- */

test("groupKeyOf groups by directory, never by filename", () => {
  assert.equal(groupKeyOf("libs/mcl/a.cpp", 1), "libs");
  assert.equal(groupKeyOf("libs/mcl/a.cpp", 2), "libs/mcl");
  // Deeper than the path goes: the whole directory part, not an empty key.
  assert.equal(groupKeyOf("libs/mcl/a.cpp", 9), "libs/mcl");
  // A file at the repo root belongs to the repo, not to itself — otherwise every
  // loose top-level file becomes its own bubble.
  assert.equal(groupKeyOf("main.cpp", 1), "");
});

test("pathOf prefers the explicit path and falls back to the sources string", () => {
  assert.equal(pathOf(node("x#y", "a/b.cpp")), "a/b.cpp");
  assert.equal(
    pathOf({ id: "x", name: "x", type: "file", summary: "", sources: ["a/b.cpp · L1-L9"] }),
    "a/b.cpp",
  );
});

test("availableDepths offers the levels the tree has, plus the file rung", () => {
  // Two directory levels, then one more where grouping is by file.
  assert.deepEqual(availableDepths(GRAPH), [1, 2, 3]);
});

test("the file rung is a property of the graph, not of one path", async () => {
  const { fileRungOf } = await import("../viewer/aggregate.js");
  // The deepest path has two significant directories (`sources` is a convention),
  // so depth 3 is where every path has run out of directories together —
  // including the top-level file that never had any.
  assert.equal(
    fileRungOf({
      meta: { nodeCount: 0, edgeCount: 0 },
      nodes: [node("libs/mcl/sources/a.cpp#x", "libs/mcl/sources/a.cpp"), node("main.cpp#m", "main.cpp")],
      edges: [],
    }),
    3,
  );
});

test("groupGraph rolls symbols into directory bubbles and bundles the edges", () => {
  const g = groupGraph(GRAPH, { depth: 2 });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.deepEqual([...byId.keys()].sort(), ["group:", "group:libs/mcl", "group:libs/sip"]);

  // Bubble size is the symbol count behind it.
  assert.equal(byId.get("group:libs/mcl")?.count, 4);
  assert.equal(byId.get("group:libs/sip")?.count, 2);

  // The two mcl→sip calls became ONE bundle carrying its weight; the edge inside
  // mcl is not drawn (it would be a self-loop) but is counted on the bubble.
  const bundle = g.edges.find((e) => e.source === "group:libs/mcl" && e.target === "group:libs/sip");
  assert.equal(bundle?.weight, 2);
  assert.ok(!g.edges.some((e) => e.source === e.target), "no self-loops on a group");
  assert.match(byId.get("group:libs/mcl")?.summary ?? "", /1 internal reference/);

  // Direction survives aggregation: sip→mcl is its own bundle, not merged.
  assert.ok(g.edges.some((e) => e.source === "group:libs/sip" && e.target === "group:libs/mcl"));
});

test("groupGraph at depth 0 filters without aggregating", () => {
  const g = groupGraph(GRAPH, { depth: 0 });
  assert.equal(g.nodes.length, GRAPH.nodes.length);
  assert.equal(g.edges.length, GRAPH.edges.length);
});

test("hideOrphans drops symbols nothing links to, and their group with them", () => {
  const g = groupGraph(GRAPH, { depth: 0, hideOrphans: true });
  const ids = g.nodes.map((n) => n.id);
  assert.ok(!ids.includes("libs/mcl/a.cpp#Unused.never"), "the orphan is gone");
  assert.equal(ids.length, GRAPH.nodes.length - 1);
});

test("scope drills into one subtree, and at the file rung shows its files", () => {
  const g = groupGraph(GRAPH, { depth: 3, scope: "libs/mcl" });
  // Depth 3 is past the deepest directory, so `libs/mcl` opens into its files
  // rather than collapsing to a single bubble containing everything.
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["group:libs/mcl/a.cpp", "group:libs/mcl/b.cpp"]);
  // Edges leaving the scope are not drawn, because their other end is not here;
  // the one inside it is.
  assert.equal(g.edges.length, 1);
});

/* ----------------------------------------------------------------- analysis -- */

test("shortestPath follows edge direction and reports unreachable honestly", () => {
  const adj = buildAdjacency(GRAPH);
  assert.deepEqual(
    shortestPath(adj, "main.cpp#main", "libs/sip/s.cpp#Registrar.bind"),
    ["main.cpp#main", "libs/mcl/a.cpp#Ua.start", "libs/sip/s.cpp#Registrar.bind"],
  );
  // The reverse direction is a different question with a different answer.
  assert.deepEqual(shortestPath(adj, "libs/sip/s.cpp#Registrar.bind", "main.cpp#main"), []);
  assert.deepEqual(shortestPath(adj, "main.cpp#main", "main.cpp#main"), ["main.cpp#main"]);
});

test("neighborhood is undirected — callers belong to a lens as much as callees", () => {
  const adj = buildAdjacency(GRAPH);
  const one = neighborhood(adj, "libs/mcl/a.cpp#Ua.start", 1);
  assert.ok(one.has("main.cpp#main"), "an incoming caller is in the neighbourhood");
  assert.ok(one.has("libs/sip/s.cpp#Registrar.bind"), "an outgoing callee is too");
  assert.ok(!one.has("libs/mcl/a.cpp#Ua.stop"), "two hops away is not");
  // `Ua.stop` is reached at two hops only by walking an edge backwards
  // (Registrar.bind's caller), and `Registrar.drop` at three the same way.
  assert.ok(neighborhood(adj, "libs/mcl/a.cpp#Ua.start", 2).has("libs/mcl/a.cpp#Ua.stop"));
  assert.ok(!neighborhood(adj, "libs/mcl/a.cpp#Ua.start", 2).has("libs/sip/s.cpp#Registrar.drop"));
  assert.ok(neighborhood(adj, "libs/mcl/a.cpp#Ua.start", 3).has("libs/sip/s.cpp#Registrar.drop"));
});

test("findCycles reports the strongly connected components, largest first", () => {
  const adj = buildAdjacency(GRAPH);
  const cycles = findCycles(adj);
  assert.equal(cycles.length, 1, `one cycle expected, got ${JSON.stringify(cycles)}`);
  // Exactly the mutually-reachable pair. `Ua.stop` and `Registrar.drop` sit on a
  // path INTO the cycle without being part of it, which is the distinction a
  // reachability check would get wrong and an SCC gets right.
  assert.deepEqual(
    cycles[0].slice().sort(),
    ["libs/mcl/a.cpp#Ua.start", "libs/sip/s.cpp#Registrar.bind"],
  );
});

test("findCycles finds nothing in an acyclic graph and survives deep chains", () => {
  // 20k deep: Tarjan written recursively would overflow the stack here, which is
  // the whole reason the implementation is iterative.
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  for (let i = 0; i < 20000; i++) {
    nodes.push(node(`f${i}`, `a/f${i}.c`));
    if (i > 0) edges.push(edge(`f${i - 1}`, `f${i}`));
  }
  const adj = buildAdjacency({ meta: { nodeCount: 0, edgeCount: 0 }, nodes, edges });
  assert.deepEqual(findCycles(adj), []);
});

test("hubs ranks by total degree and ignores isolated nodes", () => {
  const adj = buildAdjacency(GRAPH);
  const top = hubs(adj, 3);
  assert.equal(top[0].id, "libs/mcl/a.cpp#Ua.start", `got ${JSON.stringify(top)}`);
  assert.equal(top[0].degree, 4);
  assert.ok(!top.some((h) => h.id === "libs/mcl/a.cpp#Unused.never"), "orphans are not hubs");
});

/* ------------------------------------------------------------------ layouts -- */

test("radialLayout puts each directory on its own ring", async () => {
  const { radialLayout } = await import("../viewer/layouts.js");
  const pos = radialLayout(GRAPH.nodes, 2);
  assert.equal(pos.length, GRAPH.nodes.length * 2);
  const centreOf = (ids: string[]) => {
    const pts = ids.map((id) => GRAPH.nodes.findIndex((n) => n.id === id));
    const x = pts.reduce((s, i) => s + pos[i * 2], 0) / pts.length;
    const y = pts.reduce((s, i) => s + pos[i * 2 + 1], 0) / pts.length;
    return [x, y];
  };
  const mcl = centreOf(["libs/mcl/a.cpp#Ua.start", "libs/mcl/a.cpp#Ua.stop"]);
  const sip = centreOf(["libs/sip/s.cpp#Registrar.bind", "libs/sip/s.cpp#Registrar.drop"]);
  const apart = Math.hypot(mcl[0] - sip[0], mcl[1] - sip[1]);
  assert.ok(apart > 100, `separate directories land on separate rings (got ${apart.toFixed(0)})`);
});

test("layeredLayout puts depth on Y and survives a cycle", async () => {
  const { layeredLayout } = await import("../viewer/layouts.js");
  const pos = layeredLayout(GRAPH, GRAPH.nodes);
  const y = (id: string) => pos[GRAPH.nodes.findIndex((n) => n.id === id) * 2 + 1];
  // `main` has no incoming edges: it is a root, at depth 0.
  assert.equal(y("main.cpp#main"), 0);
  // Everything it reaches sits below it, and the cycle does not hang or explode.
  assert.ok(y("libs/mcl/a.cpp#Ua.start") > y("main.cpp#main"));
  assert.ok(Number.isFinite(y("libs/sip/s.cpp#Registrar.bind")));
});

test("group labels take the last segment, and more of it only when they clash", async () => {
  const { labelsFor } = await import("../viewer/aggregate.js");
  const l = labelsFor([
    "CMU_LIBS/elmMcl",
    "CMU_LIBS/elmSnmp/snmp",
    "web/snmp",
    "headers",
  ]);
  // Unique tails stay short.
  assert.equal(l.get("CMU_LIBS/elmMcl"), "elmMcl");
  assert.equal(l.get("headers"), "headers");
  // Two groups ending in `snmp` each take one more segment — and only those two.
  assert.equal(l.get("CMU_LIBS/elmSnmp/snmp"), "elmSnmp/snmp");
  assert.equal(l.get("web/snmp"), "web/snmp");
});

test("group labels never render two identical names", () => {
  const g = groupGraph(
    {
      meta: { nodeCount: 0, edgeCount: 0 },
      nodes: [
        node("a/web/x.c#f", "a/web/x.c"),
        node("b/web/y.c#g", "b/web/y.c"),
        node("c/z.c#h", "c/z.c"),
      ],
      edges: [],
    },
    { depth: 2 },
  );
  const names = g.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length, `duplicate labels: ${names.join(", ")}`);
  assert.ok(names.includes("a/web"), `got ${names.join(", ")}`);
  assert.ok(names.includes("b/web"), `got ${names.join(", ")}`);
});

test("seedPositions clusters by directory and scales the spread to what must fit", async () => {
  const { seedPositions } = await import("../viewer/layouts.js");
  const nodes = [
    node("libs/mcl/a.cpp#one", "libs/mcl/a.cpp"),
    node("libs/mcl/a.cpp#two", "libs/mcl/a.cpp"),
    node("libs/mcl/b.cpp#three", "libs/mcl/b.cpp"),
    node("libs/sip/s.cpp#four", "libs/sip/s.cpp"),
    node("libs/sip/s.cpp#five", "libs/sip/s.cpp"),
  ];
  const radii = Float32Array.from([12, 12, 12, 12, 12]);
  const pos = seedPositions(nodes, radii, 800, 600);
  const at = (i: number) => [pos[i * 2], pos[i * 2 + 1]] as const;
  const gap = (a: number, b: number) => Math.hypot(at(a)[0] - at(b)[0], at(a)[1] - at(b)[1]);

  // Same directory starts together; different directories start apart.
  const within = Math.max(gap(0, 1), gap(0, 2), gap(1, 2));
  const between = Math.min(gap(0, 3), gap(0, 4), gap(2, 3));
  assert.ok(between > within, `mcl and sip should seed apart (within ${within.toFixed(0)}, between ${between.toFixed(0)})`);

  // Nobody starts on top of anybody: the pile the forces used to untangle.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      assert.ok(gap(i, j) > radii[i], `${i} and ${j} overlap at spawn (${gap(i, j).toFixed(1)})`);
    }
  }
});

test("seedPositions spreads a big graph further than a small one", async () => {
  const { seedPositions } = await import("../viewer/layouts.js");
  const make = (n: number) => {
    const nodes = Array.from({ length: n }, (_, i) => node(`d${i % 7}/f.c#s${i}`, `d${i % 7}/f.c`));
    return seedPositions(nodes, Float32Array.from(nodes.map(() => 12)), 800, 600);
  };
  const extent = (pos: Float32Array) => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < pos.length; i += 2) { min = Math.min(min, pos[i]); max = Math.max(max, pos[i]); }
    return max - min;
  };
  // Area-based sizing: 400 nodes need meaningfully more room than 40.
  assert.ok(extent(make(400)) > extent(make(40)) * 2, "the seed disc grows with what goes in it");
});

test("groupKeyOf ignores directories that name a file type, not a component", () => {
  // A module split into headers/ and sources/ is one module. Grouping by those
  // puts a class's declarations in a different bubble from its definitions, and
  // fills the top level of a C++ tree with bubbles called `headers` and `sources`.
  assert.equal(groupKeyOf("CMU_LIBS/elmMcl/headers/a.h", 2), "CMU_LIBS/elmMcl");
  assert.equal(groupKeyOf("CMU_LIBS/elmMcl/sources/a.cpp", 2), "CMU_LIBS/elmMcl");
  assert.equal(groupKeyOf("src/graph/extract.ts", 1), "graph");
  // A file whose every directory is a convention belongs to no module — it is the
  // repo's own code, and gets the root group rather than a bubble called `src`.
  assert.equal(groupKeyOf("src/main.ts", 1), "");
  assert.equal(groupKeyOf("sources/main.cpp", 2), "");
});

test("headers and sources land in the same group, and stop being groups themselves", () => {
  const g = groupGraph(
    {
      meta: { nodeCount: 0, edgeCount: 0 },
      nodes: [
        node("libs/mcl/headers/a.h#Decl", "libs/mcl/headers/a.h"),
        node("libs/mcl/sources/a.cpp#Def", "libs/mcl/sources/a.cpp"),
        node("libs/sip/include/s.h#Other", "libs/sip/include/s.h"),
      ],
      edges: [],
    },
    { depth: 2 },
  );
  const ids = g.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["group:libs/mcl", "group:libs/sip"]);
  assert.equal(g.nodes.find((n) => n.id === "group:libs/mcl")?.count, 2, "both halves of the module");
});

test("top-level convention directories become one repo-root group, named for the repo", () => {
  const g = groupGraph(
    {
      meta: { nodeCount: 0, edgeCount: 0, repoName: "CMU" },
      nodes: [
        node("headers/a.h#A", "headers/a.h"),
        node("sources/a.cpp#B", "sources/a.cpp"),
        node("CMU_LIBS/elmMcl/sources/m.cpp#C", "CMU_LIBS/elmMcl/sources/m.cpp"),
      ],
      edges: [],
    },
    { depth: 2 },
  );
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  // No `headers` or `sources` bubble: both are the repo's own code.
  assert.deepEqual([...byId.keys()].sort(), ["group:", "group:CMU_LIBS/elmMcl"]);
  assert.equal(byId.get("group:")?.name, "CMU", "the root group is named after the repo");
  assert.equal(byId.get("group:")?.count, 2);
});

/* ------------------------------------------------------------- entry-rooted -- */

test("findRoot prefers a conventional entry file, shallowest first", async () => {
  const { findRoot } = await import("../viewer/layouts.js");
  const g: VizGraph = {
    meta: { nodeCount: 0, edgeCount: 0 },
    nodes: [
      node("vendor/dep/main.c#x", "vendor/dep/main.c"),
      node("main.cpp#app", "main.cpp"),
      node("libs/util.cpp#helper", "libs/util.cpp"),
    ],
    edges: [edge("main.cpp#app", "libs/util.cpp#helper")],
  };
  // The top-level entry point, not the one buried in a dependency.
  assert.equal(findRoot(g), "main.cpp#app");
});

test("findRoot falls back to what depends on the most, not what is depended on most", async () => {
  const { findRoot } = await import("../viewer/layouts.js");
  const g: VizGraph = {
    meta: { nodeCount: 0, edgeCount: 0 },
    nodes: ["a", "b", "c", "hub"].map((n) => node(`f.c#${n}`, "f.c")),
    edges: [
      edge("f.c#a", "f.c#hub"), edge("f.c#b", "f.c#hub"), edge("f.c#c", "f.c#hub"),
      edge("f.c#a", "f.c#b"), edge("f.c#a", "f.c#c"),
    ],
  };
  // `hub` has the highest total degree, but it is the BOTTOM of the graph — `a` is
  // what reaches everything, and a program is drawn from its top.
  assert.equal(findRoot(g), "f.c#a");
});

test("findRoot on a rolled-up graph picks the repo's own root group", async () => {
  const { findRoot } = await import("../viewer/layouts.js");
  const g = groupGraph(
    {
      meta: { nodeCount: 0, edgeCount: 0, repoName: "CMU" },
      nodes: [node("sources/main.cpp#main", "sources/main.cpp"), node("libs/mcl/a.cpp#f", "libs/mcl/a.cpp")],
      edges: [edge("sources/main.cpp#main", "libs/mcl/a.cpp#f")],
    },
    { depth: 2 },
  );
  assert.equal(findRoot(g), "group:");
});

test("radialTreeSeed puts the root at the centre and each layer on its own ring", async () => {
  const { radialTreeSeed } = await import("../viewer/layouts.js");
  const g: VizGraph = {
    meta: { nodeCount: 0, edgeCount: 0 },
    nodes: ["main", "a", "b", "deep", "island"].map((n) => node(`f.c#${n}`, "f.c")),
    edges: [
      edge("f.c#main", "f.c#a"), edge("f.c#main", "f.c#b"), edge("f.c#a", "f.c#deep"),
    ],
  };
  const radii = Float32Array.from(g.nodes.map(() => 12));
  const pos = radialTreeSeed(g, radii, 800, 600, "f.c#main")!;
  const at = (id: string) => {
    const i = g.nodes.findIndex((n) => n.id === id);
    return Math.hypot(pos[i * 2] - 400, pos[i * 2 + 1] - 300);
  };
  assert.equal(at("f.c#main"), 0, "the root is the centre");
  // One hop out, two hops further out, and both hops at the same radius as each other.
  assert.ok(Math.abs(at("f.c#a") - at("f.c#b")) < 0.001, "same depth, same ring");
  assert.ok(at("f.c#deep") > at("f.c#a"), "deeper means further out");
  // Nothing reaches `island`, so it rings the outside rather than vanishing.
  assert.ok(at("f.c#island") > at("f.c#deep"), "unreachable nodes go outermost");
});
