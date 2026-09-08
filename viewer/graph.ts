/**
 * Force-directed graph view, drawn to a canvas.
 *
 * It was SVG until a 26k-node graph made the cost obvious: one `<g>` plus three
 * children per node and a `<path>` plus a `<text>` per edge is ~134,000 elements,
 * and every simulation tick wrote ~70,000 attributes, each one dirtying SVG
 * layout. Under 1fps. Canvas turns that into a few dozen draw calls a frame, and
 * the layout itself moved to a Worker (see ./sim.ts) because at that size it costs
 * ~90ms a tick — eight frames — all on its own.
 *
 * The three rules that keep it fast, in order of how much they buy:
 *   1. BATCH. Nodes are filled per colour and edges stroked per style, so 26k
 *      circles are seven `fill()` calls and 15k edges are eight `stroke()` calls.
 *   2. DRAW ONLY WHEN DIRTY. A settled graph nobody is touching costs zero.
 *   3. TEXT IS THE EXPENSIVE PART. Labels are capped, prioritised, and skipped
 *      entirely when zoomed far enough out that they would be unreadable anyway.
 *
 * Edge grammar (per the design spec):
 *   part of            thick · muted · no arrowhead · short spring
 *   uses-family        solid · open-chevron arrowhead
 *   extends/implements hollow arrowhead
 *   references         faint dots · no arrowhead
 *   inferred edges     dashed (trust is visible)
 * Focus mode: selecting a node paints outgoing edges amber ("depends on"),
 * incoming teal ("depended on by"), labels the verbs on just those edges,
 * and fades the rest of the graph.
 */
import { type VizGraph, type VizEdge, type NodeOwner, famOf, REST, chipKey, colorToken, cvar, verbFor } from "./data.js";
import { groupPalette, radiusAt, shapeOf, shapePath, sizedFor, textWidthIn, type Shape } from "./palette.js";
import { significantDirs } from "./aggregate.js";
import { initials } from "./detail.js";
import { LayoutDriver } from "./sim.js";
import type { SimSpec } from "./sim-core.js";
import { seedPositions, orbitLayout } from "./layouts.js";

/** A node as the renderer needs it. Positions live in the layout's flat buffer,
 * never here — copying 26k pairs into objects every frame is exactly the per-tick
 * cost this rewrite exists to remove. */
export interface SimNode {
  id: string;
  name: string;
  type: string;
  deg: number;
  r: number;
  owners?: NodeOwner[];
  /** Source path, or the directory a rolled-up bubble stands for. */
  path?: string;
  /** Symbols behind a rolled-up bubble; drives its radius. */
  count?: number;
  /** The directory this belongs to — what its colour encodes. */
  group: string;
  shape: Shape;
}

/** What a click on an edge reports back. */
export interface PickedEdge {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  members?: Array<{ source: string; target: string }>;
  moreMembers?: number;
}

interface SimEdge {
  s: number;
  t: number;
  relation: string;
  /** How far this edge bows off the straight line between its ends, signed.
   * Several edges between the same two nodes fan out instead of being drawn on
   * top of each other — which is what made a pair joined by both `calls` and
   * `imports` look like one edge wearing whichever label was painted last. */
  bow: number;
  description?: string;
  confidence?: string;
  /** Edges behind a rolled-up bundle; drives stroke width. */
  weight?: number;
  members?: Array<{ source: string; target: string }>;
  moreMembers?: number;
}

/** Initials shown on a bubble before the rest become a count. Two faces read as
 * "someone else owns this"; five read as a pie chart nobody asked for. */
const MAX_BADGES = 2;

/**
 * Zoom range. The floor is deliberately far out — a 26k-node graph is ~40,000
 * world units across, and anything less permissive than this simply cannot show
 * it. The ceiling is where a single node fills the viewport.
 */
const MIN_K = 0.01;
const MAX_K = 16;

/** Screen-space floors. Below them a zoomed-out graph degenerates into an empty
 * canvas: sub-pixel circles and hairline strokes render as nothing at all. Held in
 * screen pixels and divided by the zoom, so they bite only when zoomed out. */
const MIN_NODE_PX = 0.8;
const MIN_EDGE_PX = 0.35;

/** Labels are the single most expensive thing on the canvas — each one is a
 * shaped, stroked and filled glyph run. Below this zoom they are unreadable, so
 * they are not drawn; above it, only this many of the most connected on-screen
 * nodes get one. Selection and search always win a label regardless. */
const LABEL_MIN_K = 0.5;
const MAX_LABELS = 320;
const LABEL_SIZE = 11.5;
const LABEL_FONT = '600 11.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** A node whose on-screen radius reaches this wears its name on its face rather
 * than hung underneath — and below it, the name would not fit anyway. */
const INSIDE_LABEL_PX = 17;
const INSIDE_LABEL_MIN = 7;
const INSIDE_LABEL_MAX = 22;

/** Arrowheads cost a fill each and are illegible when small; past this many
 * on-screen edges they are dropped except on the focused ones. */
const ARROW_MIN_K = 0.9;
const MAX_ARROWS = 3000;

/** How far a lone edge bows off the straight line, and how far apart the lanes
 * sit when several edges share a pair of nodes. */
const BOW = 10;
const BOW_STEP = 26;

/** The gap an edge leaves between its end and the outline it points at: enough
 * to read as touching rather than piercing, at every zoom. */
const EDGE_GAP = 4;

/** The widest ring a node can wear (see `paintRings`), so an edge into a selected
 * node stops outside its ring instead of under it. */
const RING_PAD = 7;

/** How far past the quartiles a point may sit and still be framed. 1.5 is Tukey's
 * own constant and is what "outlier" conventionally means. */
const FENCE = 1.5;

/** Below this a full-detail frame is cheap enough that a moving graph never needs
 * the draft pass — and a small graph is where the detail actually reads. */
const DRAFT_MIN_NODES = 1500;

/** The directory a node's colour stands for. A rolled-up bubble IS its group;
 * a loose symbol takes the first two segments of its path, matching how the
 * layout seeds clusters so colour and position tell the same story. */
function groupKeyFor(n: { type: string; path?: string; sources?: string[]; id: string }): string {
  if (n.type === "group") return n.path ?? n.id;
  const path = n.path ?? n.sources?.[0]?.split(" · ")[0] ?? "";
  return significantDirs(path).slice(0, 2).join("/") || path || "·";
}

/** Halos are a radial gradient each — only the top handful get one, and only on a
 * graph large enough that picking the hubs out by eye is genuinely hard. */
const MAX_GLOWS = 40;
const GLOW_MIN_NODES = 200;

/** Border between adjacent shapes, in screen pixels. */
const BORDER_PX = 1.6;

/** The minimap earns its corner only on a graph big enough to get lost in. */
const MINIMAP_MIN_NODES = 400;
const MINIMAP_W = 150;
const MINIMAP_SAMPLES = 3000;

/** Owner badges are two circles and a glyph run each — prominent nodes only. */
const BADGE_MIN_K = 0.8;

/** Breathing room between neighbours on a focus ring, in world units. */
const RING_GAP = 12;
/** How much wider than the exact fit a focus ring is drawn. */
const RING_EASE = 1.05;

/** Breathing room left between two nodes when one is pushed clear of another, how
 * many times one node may be shoved in a single drag frame, and the total number
 * of shoves that frame is allowed. */
const SEPARATION_GAP = 6;

/** How many times an evicted node may step further out looking for a clear spot
 * before it settles for where it got to. */
const EVICT_STEPS = 24;
const MAX_PUSHES = 3;
const SEPARATION_BUDGET = 400;

/** The empty wedge left at each side of the ring, separating "what this depends
 * on" above from "what depends on this" below. */
const ARC_SPLIT = Math.PI * 0.09;
/** How long a rearrangement takes to travel, in milliseconds. */
const TWEEN_MS = 480;

/** Hit-test grid cell, in world units. Roughly three node diameters: big enough
 * that the grid stays small, small enough that a lookup scans a handful of nodes. */
const GRID_CELL = 96;

/** Resolved theme tokens. `cvar` is `getComputedStyle` under the hood — calling it
 * per node per frame was costing more than the drawing did. */
interface Theme {
  /** Directory → colour. The primary encoding: what module is this. */
  groups: Map<string, string>;
  edge: string;
  canvas: string;
  ink: string;
  panel: string;
  con: string;
  out: string;
  in: string;
  node: Record<string, string>;
}

/** Tukey fences over sorted values, clamped to the data that actually exists —
 * so a tight cluster is never framed wider than itself. */
function fence(sorted: Float64Array, pad: number): [number, number] {
  const n = sorted.length;
  if (n === 0) return [-pad, pad];
  const q = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  return [
    Math.max(sorted[0], q1 - iqr * FENCE) - pad,
    Math.min(sorted[n - 1], q3 + iqr * FENCE) + pad,
  ];
}

/**
 * Black or white, whichever can be read on `color`.
 *
 * Relative luminance rather than a naive average: the eye is far more sensitive
 * to green than to blue, so averaging the channels calls a saturated blue "light"
 * and puts black text on it.
 */
function readableOn(color: string): string {
  const m = /hsl\(\s*[\d.]+\s+[\d.]+%\s+([\d.]+)%/.exec(color);
  if (m) return Number(m[1]) > 58 ? "#101315" : "#FFFFFF";
  const hex = color.trim();
  if (!hex.startsWith("#") || hex.length < 7) return "#101315";
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.58 ? "#101315" : "#FFFFFF";
}

function rgba(color: string, alpha: number): string {
  const hex = color.trim();
  if (!hex.startsWith("#")) return hex;
  const n = hex.length === 4
    ? [hex[1] + hex[1], hex[2] + hex[2], hex[3] + hex[3]]
    : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  const [r, g, b] = n.map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

/** One batched draw: a path plus the state to draw it with. */
interface Bucket {
  path: Path2D;
  color: string;
  alpha: number;
  width: number;
  dash: number[];
}

export class GraphView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private layout = new LayoutDriver();

  private nodes: SimNode[] = [];
  private edges: SimEdge[] = [];
  private index = new Map<string, number>();
  private theme!: Theme;
  /** Group keys in the order their hues were assigned. */
  private groupOrder: string[] = [];

  private view = { x: 0, y: 0, k: 1 };
  /** Where the camera is heading, when a move is being animated. */
  private target: { x: number; y: number; k: number } | null = null;
  /**
   * True once the reader has moved the camera themselves.
   *
   * The force layout expands for several seconds after it starts, so the fit
   * computed at seed time is wrong by the time it settles — but re-fitting under
   * someone who has panned somewhere deliberately is worse than a bad fit. So it
   * re-fits exactly once, on settle, and only if they have not taken over.
   */
  private userMoved = false;
  private wasHot = false;
  /** Auto-fit is a once-per-dataset courtesy, not a policy. Without this it fires
   * again after every reheat — including the one a drag causes, so arranging the
   * graph by hand kept yanking the camera out from under the reader. */
  private fittedOnce = false;
  private tab: "context" | "code" = "context";
  private dpr = 1;
  private width = 0;
  private height = 0;

  /** Set by anything that changes the picture; consumed by the render loop. */
  private dirty = false;
  private frame = 0;

  /** Lazily rebuilt hit-test grid, invalidated whenever positions move. */
  private grid = new Map<number, number[]>();
  private gridStamp = -1;
  private stamp = 0;

  /** Indices of the most connected nodes, for the glow. Recomputed with the data,
   * never per frame. */
  private hubIndices: number[] = [];
  /** Last drawn minimap geometry, so a click in it can be turned back into a
   * world position. Null until one has been drawn. */
  private minimap: { x0: number; y0: number; w: number; h: number; scale: number; cx: number; cy: number } | null = null;
  private neighbors = new Set<number>();
  private selectedEdge: SimEdge | null = null;
  private hover = -1;
  private hoverQueued = false;
  /** Nodes the reader has placed by hand. They stay put until released. */
  /** The graph as handed over, kept so a layout can be recomputed in place —
   * `orbitLayout` needs the edges by id, which the packed sim arrays no longer
   * carry. */
  private graph: VizGraph | null = null;
  private pinned = new Set<number>();
  /** Nodes currently held in a ring around the selection. Released when the
   * selection changes, unless the reader had pinned them themselves. */
  private arranged = new Set<number>();
  /** An in-flight rearrangement: where each node was, and where it is going. */
  private tween: Array<{ i: number; fx: number; fy: number; tx: number; ty: number }> = [];
  private tweenStart = 0;

  /**
   * Built geometry, reused across frames that only moved the camera.
   *
   * Panning and zooming change no world coordinate, so rebuilding 26k arcs and 14k
   * curves for each one was the difference between 26fps and 60 while zoomed out.
   * The key names everything the geometry actually depends on; the zoom appears in
   * it only through a coarse bucket, because the minimum on-screen node radius is
   * baked into the arcs and nothing else about `k` is.
   */
  private geomCache: { edges: Bucket[]; nodes: Bucket[]; focused: { e: SimEdge; role: "out" | "in" }[]; arrows: SimEdge[] | null } | null = null;
  private geomKey = "";
  /** Bumped whenever `spotlight` is replaced, so the cache key notices a set of
   * the same size holding different ids. */
  private spotVersion = 0;

  selected: string | null = null;
  query = "";
  hiddenRels: Record<string, boolean> = {};
  hiddenTypes: Record<string, boolean> = {};
  /** The contributor badges on each bubble. A decoration, not a filter — toggling
   * it never changes which nodes are on the canvas. */
  showOwners = true;
  onSelect: (id: string | null) => void = () => {};
  /** Ctrl/⌘-click: re-lay the whole graph as a tree of orbits rooted here. */
  onOrbit: (id: string) => void = () => {};
  /** A group bubble was clicked: the caller decides what drilling in means. */
  onDrill: (prefix: string) => void = () => {};
  /** An edge was clicked, or the selection was cleared. Carries the real symbol
   * pairs behind a bundle so the caller can say WHICH call relates two modules. */
  onSelectEdge: (edge: PickedEdge | null) => void = () => {};
  /**
   * The answer to whatever question was last asked of the graph — a cycle, a
   * dependency path, a k-hop lens, the top hubs. One mechanism for all of them:
   * ids in the set stay lit, everything else recedes, and edges between two lit
   * nodes are painted as the finding. Null means no question is being asked.
   */
  spotlight: Set<string> | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx = ctx;
    this.tip = document.createElement("div");
    this.tip.className = "gtip";
    this.tip.hidden = true;
    canvas.parentElement?.appendChild(this.tip);

    this.readTheme();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.layout.onFrame = () => {
      this.stamp++;
      this.dirty = true;
      // Leaving the draft pass is itself a reason to repaint.
      if (this.wasHot && !this.layout.hot) this.geomCache = null;
      if (this.wasHot && !this.layout.hot && !this.userMoved && !this.fittedOnce) {
        this.fittedOnce = true;
        this.resetView();
      }
      this.wasHot = this.layout.hot;
    };
    this.bindPointer();
    this.loop();
  }

  /* ------------------------------------------------------------------ data -- */

  /** Load (or morph into) a new dataset. Nodes keep their positions by id. */
  setData(graph: VizGraph, tab: "context" | "code"): void {
    this.tab = tab;
    this.graph = graph;
    const prevIndex = this.index;
    const prevPos = this.layout.positions;

    const deg: Record<string, number> = {};
    for (const e of graph.edges) {
      deg[e.source] = (deg[e.source] ?? 0) + 1;
      deg[e.target] = (deg[e.target] ?? 0) + 1;
    }

    const W = this.width || 800;
    const H = this.height || 600;
    const count = graph.nodes.length;
    const positions = new Float32Array(count * 2);
    const radii = new Float32Array(count);

    this.nodes = graph.nodes.map((n, i) => {
      const d = deg[n.id] ?? 0;
      // A rolled-up bubble is sized by what is inside it, on a square root so a
      // 4,000-symbol module is bigger than a 400-symbol one without being ten
      // times the width. A plain symbol is sized by how connected it is.
      const r = n.count
        ? 14 + Math.min(52, Math.sqrt(n.count) * 3.4)
        : 11 + Math.min(13, d * 2.6);
      // What the SIM is told is the radius of what gets DRAWN, which for every
      // shape but a circle is larger than `r` — a triangle covers the same area
      // by reaching 1.55x further out. Collision, spring length and repulsion all
      // read this, so telling them the circle radius is precisely why triangles
      // and squares still spawned on top of each other.
      radii[i] = sizedFor(shapeOf(n.type), r);
      return {
        id: n.id, name: n.name, type: n.type, owners: n.owners, deg: d, r,
        path: n.path, count: n.count,
        group: groupKeyFor(n), shape: shapeOf(n.type),
      };
    });

    // Seed clustered by directory and spaced by area (see ./layouts.ts), then let
    // anything that already had a position keep it — morphing between two views of
    // the same graph should move what changed and nothing else.
    positions.set(seedPositions(graph.nodes, radii, W, H, graph));
    for (let i = 0; i < count; i++) {
      const prev = prevIndex.get(graph.nodes[i].id);
      if (prev !== undefined && prevPos.length > prev * 2 + 1) {
        positions[i * 2] = prevPos[prev * 2];
        positions[i * 2 + 1] = prevPos[prev * 2 + 1];
      }
    }

    this.index = new Map(this.nodes.map((n, i) => [n.id, i]));
    // Hues are handed out in size order, so the biggest modules get the most
    // separated colours — that is where separation is worth the most.
    this.groupOrder = [...new Set(this.nodes.map((n) => n.group))].sort((a, b) => {
      const size = (g: string) => this.nodes.reduce((k, n) => k + (n.group === g ? 1 : 0), 0);
      return size(b) - size(a) || a.localeCompare(b);
    });

    const links: number[] = [];
    const distances: number[] = [];
    this.edges = [];
    for (const e of graph.edges as VizEdge[]) {
      const s = this.index.get(e.source);
      const t = this.index.get(e.target);
      if (s === undefined || t === undefined) continue;
      this.edges.push({
        s, t, relation: e.relation, bow: 0, description: e.description, confidence: e.confidence,
        weight: e.weight, members: e.members, moreMembers: e.moreMembers,
      });
      links.push(s, t);
      // Rest length measures the GAP between two bubbles, not their centres —
      // otherwise a 60-unit module and a 12-unit one sit at the same distance and
      // the big one swallows the link.
      distances.push(REST[famOf(e.relation)] * 1.6 + radii[s] + radii[t]);
    }

    this.fanOut();

    const spec: SimSpec = {
      count,
      radii,
      links: Uint32Array.from(links),
      distances: Float32Array.from(distances),
      positions,
      width: W,
      height: H,
    };
    this.pinned.clear();
    this.arranged.clear();
    // Every index below points into the OLD node array. Drilling into a group
    // swaps in a smaller one, so a hover left over from the previous graph is a
    // read past the end — `paintRings` crashed on exactly that. The selected edge
    // holds two such indices of its own.
    this.hover = -1;
    this.selectedEdge = null;
    this.tween = [];
    this.hubIndices = this.nodes
      .map((n, i) => [i, n.deg] as const)
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_GLOWS)
      .map(([i]) => i);

    this.layout.setData(spec);
    this.userMoved = false;
    this.fittedOnce = false;
    this.wasHot = true;
    this.restyle();
  }

  /* ----------------------------------------------------------------- style -- */

  private readTheme(): void {
    // Every type the two palettes define, `group` included — a type missing here
    // silently falls back to the edge colour, which reads as "broken", not "other".
    const types = ["file", "class", "function", "method", "interface", "type", "enum",
      "system", "concept", "api", "changed", "affected", "group"];
    const node: Record<string, string> = {};
    for (const t of types) node[t] = cvar(colorToken(this.tab, t));
    const dark = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim().toLowerCase() < "#800000";
    this.theme = {
      groups: groupPalette(this.groupOrder, dark),
      edge: cvar("--edge"),
      canvas: cvar("--canvas"),
      ink: cvar("--ink"),
      panel: cvar("--panel"),
      con: cvar("--con"),
      out: cvar("--fil"),
      in: cvar("--accent"),
      node,
    };
  }

  /**
   * Recompute everything the next frame depends on, then mark it dirty.
   *
   * Under SVG this walked 134,000 elements and wrote attributes to each; now it
   * resolves a dozen CSS variables and a neighbour set, and the frame does the
   * rest. That is why search-as-you-type stopped being a slideshow.
   */
  restyle(): void {
    this.readTheme();
    this.neighbors.clear();
    const sel = this.selected === null ? -1 : this.index.get(this.selected) ?? -1;
    if (sel >= 0) {
      for (const e of this.edges) {
        if (e.s === sel) this.neighbors.add(e.t);
        else if (e.t === sel) this.neighbors.add(e.s);
      }
    }
    // The cache bakes theme colours into its buckets, and the key cannot see a
    // theme swap — drop it outright rather than encode a palette in a string.
    this.geomCache = null;
    this.spotVersion++;
    this.dirty = true;
  }

  /**
   * Select a node — and, unless told otherwise, ring its neighbours around it.
   *
   * `arrange: false` is for a selection the VIEW makes on the reader's behalf:
   * right after a ctrl-click re-roots the orbit layout, ringing the new root would
   * pull its children straight back out of the tree just built for them. It pans
   * to the node instead, at the same zoom.
   *
   * A selection the reader makes by clicking always arranges, in every layout
   * mode. Gating that on the mode meant one ctrl-click turned ordinary clicking
   * off for good, which is not a trade anybody agreed to.
   */
  select(id: string | null, opts: { arrange?: boolean } = {}): void {
    this.selected = id;
    if (id !== null) this.selectedEdge = null;
    if (opts.arrange ?? true) this.arrangeAround(id === null ? -1 : this.index.get(id) ?? -1);
    else if (id !== null) this.centerOn(id);
    this.restyle();
    this.onSelect(id);
  }

  /**
   * Lay a selection's neighbours out in a ring around it.
   *
   * A force layout answers "what is near what" for the graph as a whole, which is
   * the wrong question once someone has picked one node: then the only thing that
   * matters is what THIS touches, and a general-purpose blob buries that among
   * everything it doesn't. So selecting rearranges the neighbourhood into the
   * shape the question has — the subject in the middle, what it calls on the
   * upper arc, what calls it on the lower one — and puts everything back when the
   * selection is dropped.
   *
   * The ring is sized so the neighbours sit side by side without touching, and
   * each one's share of the arc is proportional to its own width, so a bubble
   * worth a thousand symbols is not allotted the same sliver as a single
   * function. Same-module neighbours are kept adjacent, so colour reads as bands
   * rather than confetti.
   */
  private arrangeAround(center: number): void {
    const previous = this.arranged;
    this.arranged = new Set();
    const targets = new Map<number, [number, number]>();

    if (center >= 0 && !this.hiddenTypes[this.nodes[center].type]) {
      const outs = new Set<number>();
      const ins = new Set<number>();
      for (const e of this.edges) {
        if (this.hiddenRels[chipKey(e.relation)]) continue;
        if (this.hiddenTypes[this.nodes[e.s].type] || this.hiddenTypes[this.nodes[e.t].type]) continue;
        if (e.s === center && e.t !== center) outs.add(e.t);
        else if (e.t === center && e.s !== center) ins.add(e.s);
      }
      // A neighbour on both sides is drawn as an outgoing one: "what this depends
      // on" is the question people ask first, and a node cannot sit twice.
      for (const i of outs) ins.delete(i);

      const pos = this.layout.positions;
      const cx = pos[center * 2];
      const cy = pos[center * 2 + 1];
      const ring = this.placeRing([...outs], [...ins], center, cx, cy, targets);
      if (targets.size > 0) {
        targets.set(center, [cx, cy]);
        this.clearSpace(center, cx, cy, ring, targets);
      }
    }

    for (const i of targets.keys()) this.arranged.add(i);

    // Hand back anything the previous selection had borrowed — but never a node
    // the reader placed themselves.
    for (const i of previous) {
      if (this.arranged.has(i) || this.pinned.has(i)) continue;
      this.layout.fix(i, null, null);
    }
    if (targets.size > 0) this.frameArrangement(targets);
    this.beginTween(targets);
  }

  /**
   * Evict whatever is standing inside the ring.
   *
   * A neighbourhood laid out in a clean circle is still unreadable if a dozen
   * unrelated bubbles are sitting on top of its edges — the arrangement makes the
   * relations findable, and anything drawn across them undoes exactly that. So
   * every node that is not part of the arrangement and falls inside the ring is
   * pushed straight out along its own bearing, which keeps the rest of the graph
   * recognisably where it was: things move outward, not somewhere else entirely.
   */
  private clearSpace(
    center: number, cx: number, cy: number, ring: number,
    targets: Map<number, [number, number]>,
  ): void {
    const pos = this.layout.positions;
    const keepOut = ring + RING_GAP * 2;
    const evicted: { i: number; angle: number }[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (i === center || targets.has(i) || this.pinned.has(i)) continue;
      if (this.hiddenTypes[this.nodes[i].type]) continue;
      const dx = pos[i * 2] - cx;
      const dy = pos[i * 2 + 1] - cy;
      const d = Math.hypot(dx, dy);
      if (d >= keepOut + this.roomOf(i)) continue;
      // Directly on the centre: no bearing to keep, so pick one from its index —
      // deterministic, and spread out rather than all fleeing the same way.
      evicted.push({ i, angle: d < 1e-3 ? (i * 2.39996) % (Math.PI * 2) : Math.atan2(dy, dx) });
    }
    if (evicted.length === 0) return;

    // Pushing each one straight out along its own bearing kept the picture
    // recognisable and left them piled on each other: several bubbles that were
    // spread across the middle share a bearing once they are all on one circle.
    // So they keep their ORDER — sorted by bearing, nothing crosses anything — but
    // take an even share of the circle, which is the same fit the ring itself uses.
    evicted.sort((a, b) => a.angle - b.angle);
    const width = (i: number) => (this.roomOf(i) + RING_GAP) * 2;
    const total = evicted.reduce((n, e) => n + width(e.i), 0);
    const widest = Math.max(...evicted.map((e) => this.roomOf(e.i)));
    const radius = Math.max(keepOut + widest, total / (Math.PI * 2));

    // Everything that is NOT moving is an obstacle. Spacing the evicted nodes
    // against each other was not enough: the band they land on runs straight
    // through whatever was already sitting out there, and since nothing puts a
    // displaced node back, that overlap then survived every later selection.
    const moving = new Set(evicted.map((e) => e.i));
    const still: { x: number; y: number; r: number }[] = [];
    for (let j = 0; j < this.nodes.length; j++) {
      if (j === center || moving.has(j) || this.hiddenTypes[this.nodes[j].type]) continue;
      if (targets.has(j)) continue; // a ring member: its target is checked below
      still.push({ x: pos[j * 2], y: pos[j * 2 + 1], r: this.roomOf(j) });
    }
    for (const [j, [tx, ty]] of targets) still.push({ x: tx, y: ty, r: this.roomOf(j) });

    // Start where the first evicted node already is, so the whole outer band is
    // rotated to match where things were rather than to an arbitrary zero.
    const from = evicted[0].angle;
    let walked = 0;
    for (const { i } of evicted) {
      const angle = from + ((walked + width(i) / 2) / total) * Math.PI * 2;
      walked += width(i);
      const r = this.roomOf(i);
      // Outward along its own bearing until it clears everything: the band is
      // where it wants to be, not where it must be.
      let at = radius;
      for (let step = 0; step < EVICT_STEPS; step++) {
        const x = cx + Math.cos(angle) * at;
        const y = cy + Math.sin(angle) * at;
        const hit = still.some((o) => Math.hypot(x - o.x, y - o.y) < r + o.r + SEPARATION_GAP);
        if (!hit) break;
        at += r + RING_GAP;
      }
      const x = cx + Math.cos(angle) * at;
      const y = cy + Math.sin(angle) * at;
      targets.set(i, [x, y]);
      still.push({ x, y, r });
    }
  }

  /**
   * Move everything to its target over {@link TWEEN_MS}, rather than teleporting.
   *
   * A graph that rearranges itself between one frame and the next has, as far as
   * the reader can tell, been replaced by a different graph: nothing connects
   * where a bubble was to where it now is. Watching it travel is what makes it the
   * same picture, seen better. The layout is told the final position immediately —
   * so it agrees with the screen the moment the tween lands — and the animation
   * itself is local, costing nothing but a lerp per node per frame.
   */
  private beginTween(targets: Map<number, [number, number]>): void {
    const pos = this.layout.positions;
    this.tween = [];
    for (const [i, [tx, ty]] of targets) {
      this.tween.push({ i, fx: pos[i * 2], fy: pos[i * 2 + 1], tx, ty });
      this.layout.fix(i, tx, ty);
    }
    this.tweenStart = performance.now();
    this.dirty = true;
  }

  /** One frame of the rearrangement; true while there is further to go. */
  private stepTween(): boolean {
    if (this.tween.length === 0) return false;
    const t = Math.min(1, (performance.now() - this.tweenStart) / TWEEN_MS);
    // Ease in and out: things that start and stop gently read as moving under
    // their own weight rather than being dragged.
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const pos = this.layout.positions;
    for (const m of this.tween) {
      pos[m.i * 2] = m.fx + (m.tx - m.fx) * e;
      pos[m.i * 2 + 1] = m.fy + (m.ty - m.fy) * e;
    }
    this.stamp++;
    if (t >= 1) { this.tween = []; return false; }
    return true;
  }

  /** Put the ring on screen: centred, and zoomed so all of it fits with a margin.
   * Arranging a neighbourhood the reader then has to go hunting for would be a
   * strictly worse answer than leaving it where it was. */
  private frameArrangement(targets: Map<number, [number, number]>): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [i, [x, y]] of targets) {
      const r = this.roomOf(i);
      minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
      minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
    }
    const pad = 70;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const k = this.clampK(Math.min(this.width / w, this.height / h));
    this.userMoved = true; // an arrangement is a deliberate move; do not auto-fit over it
    this.glideTo({
      k,
      x: this.width / 2 - ((minX + maxX) / 2) * k,
      y: this.height / 2 - ((minY + maxY) / 2) * k,
    });
  }

  /**
   * Put every neighbour on ONE ring, at the smallest radius that fits them all.
   *
   * Two independent arcs — callees over a half circle, callers under it — sized
   * themselves separately, so eleven neighbours landed at 315 and twenty-eight at
   * 861: the same relationship drawn at two distances, which reads as a random
   * scatter rather than as a ring. Dealing the overflow onto extra rings had the
   * same fault for the same reason.
   *
   * So the two sides SHARE a radius and split the circle in proportion to what
   * each has to carry. The crowded side gets the arc it needs, the sparse side
   * stays legible, every neighbour sits the same distance out, and that distance
   * is the exact circumference fit — the closest a ring can be while holding
   * everything side by side. Above and below still mean what they meant: what
   * this depends on, and what depends on it.
   */
  private placeRing(
    outs: number[], ins: number[], center: number, cx: number, cy: number,
    targets: Map<number, [number, number]>,
  ): number {
    const members = [...outs, ...ins];
    if (members.length === 0) return 0;

    // Same-module neighbours adjacent, biggest first within a module.
    const order = (a: number, b: number): number =>
      this.nodes[a].group.localeCompare(this.nodes[b].group) || this.roomOf(b) - this.roomOf(a);
    outs.sort(order);
    ins.sort(order);

    const width = (i: number) => (this.roomOf(i) + RING_GAP) * 2;
    const sum = (list: number[]): number => list.reduce((n, i) => n + width(i), 0);
    const wOut = sum(outs), wIn = sum(ins), total = wOut + wIn;

    // Left and right stay empty, so the two halves read as two answers rather
    // than as one uninterrupted circle.
    const usable = Math.PI * 2 - ARC_SPLIT * 2;
    const spanOut = outs.length === 0 ? 0 : ins.length === 0 ? usable : usable * (wOut / total);
    const spanIn = usable - spanOut;

    const widest = Math.max(...members.map((i) => this.roomOf(i)));
    const radius = Math.max(
      this.roomOf(center) + widest + RING_GAP * 2,
      (total / usable) * RING_EASE,
    );

    const lay = (list: number[], from: number, span: number): void => {
      const t = sum(list);
      let walked = 0;
      for (const i of list) {
        const angle = from + ((walked + width(i) / 2) / t) * span;
        walked += width(i);
        targets.set(i, [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
      }
    };
    // Canvas y grows downward, so the top half — what this depends on — is the
    // negative one, and each arc is centred on its own pole.
    lay(outs, -Math.PI / 2 - spanOut / 2, spanOut);
    lay(ins, Math.PI / 2 - spanIn / 2, spanIn);
    // The ring's OUTER edge, not its centre line: what gets evicted has to clear
    // the widest bubble on the ring, not the circle it sits on, or a big neighbour
    // and a bystander just outside the keep-out radius still overlap.
    return radius + widest;
  }

  private selectEdge(edge: SimEdge | null): void {
    this.selectedEdge = edge;
    if (edge) this.selected = null;
    this.restyle();
    this.onSelectEdge(edge && {
      source: this.nodes[edge.s].id,
      target: this.nodes[edge.t].id,
      relation: edge.relation,
      weight: edge.weight,
      members: edge.members,
      moreMembers: edge.moreMembers,
    });
  }

  /* ------------------------------------------------------------------ view -- */

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.layout.resize(this.width, this.height);
    this.dirty = true;
  }

  private clampK(k: number): number {
    return Math.max(MIN_K, Math.min(MAX_K, k));
  }

  /** Animate the camera rather than teleporting it: a jump cut across a graph
   * this size loses the reader completely, and 300ms of travel is what tells them
   * the new view is the same graph seen from somewhere else. */
  private glideTo(to: { x: number; y: number; k: number }): void {
    this.target = to;
    this.dirty = true;
  }

  /** One frame of camera travel; true while there is further to go. */
  private stepCamera(): boolean {
    if (!this.target) return false;
    const t = this.target;
    // Exponential ease: fast start, soft landing, and no duration to track.
    const step = 0.18;
    this.view.x += (t.x - this.view.x) * step;
    this.view.y += (t.y - this.view.y) * step;
    this.view.k += (t.k - this.view.k) * step;
    if (Math.abs(t.k - this.view.k) < t.k * 0.002 && Math.hypot(t.x - this.view.x, t.y - this.view.y) < 0.5) {
      this.view = { ...t };
      this.target = null;
      return false;
    }
    return true;
  }

  zoomBy(factor: number): void {
    this.userMoved = true;
    this.target = null;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const k = this.clampK(this.view.k * factor);
    this.view.x = cx - (cx - this.view.x) * (k / this.view.k);
    this.view.y = cy - (cy - this.view.y) * (k / this.view.k);
    this.view.k = k;
    this.dirty = true;
  }

  /**
   * Fit the whole graph, rather than snapping to 1:1.
   *
   * On a large graph 1:1 is a random corner of a hairball forty thousand units
   * across — the button that is supposed to get you un-lost was the fastest way to
   * get lost. Fitting is what "reset" always meant.
   */
  resetView(): void {
    const pos = this.layout.positions;
    if (pos.length === 0) { this.view = { x: 0, y: 0, k: 1 }; this.dirty = true; return; }
    // Fit the bulk, not the extremes. Unconnected modules drift far from everything
    // else, and framing them shrinks the part anyone came to look at to a smudge in
    // the middle. Tukey fences rather than a fixed percentile: a percentile has to
    // be told how many outliers to expect, and rounds down to zero on a graph of
    // sixty — the exact case where three strays do the most damage. The fences
    // adapt to the spread itself, so a graph with no strays is framed whole.
    // Anything outside stays reachable by panning or from the minimap.
    const xs = Float64Array.from(this.nodes, (_, i) => pos[i * 2]).sort();
    const ys = Float64Array.from(this.nodes, (_, i) => pos[i * 2 + 1]).sort();
    const pad = 40;
    const [minX, maxX] = fence(xs, pad);
    const [minY, maxY] = fence(ys, pad);
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const k = this.clampK(Math.min(this.width / w, this.height / h) * 0.92);
    this.glideTo({
      k,
      x: this.width / 2 - ((minX + maxX) / 2) * k,
      y: this.height / 2 - ((minY + maxY) / 2) * k,
    });
  }

  /** Center the view on a node and select it (used by search). */
  /**
   * Re-lay the graph as a tree of orbits rooted at `id`, travelling there.
   *
   * Rebuilding the view instead — which is what this did — recomputes the whole
   * dataset and drops the new positions in, so the graph teleports. A click that
   * rings a node's neighbours glides them into place over half a second, and the
   * reader can follow which bubble went where; re-rooting was the same kind of
   * move and had no business looking like a different picture arriving. Same
   * tween, same camera glide, no rebuild.
   */
  orbitTo(id: string): boolean {
    if (!this.graph) return false;
    const positions = orbitLayout(this.graph, this.graph.nodes, this.radii, id);
    if (!positions) return false;
    // Freeze first, from where things are now: an exact layout owns the buffer,
    // and a simulation left running would fight the tween for it.
    this.layout.setStatic(Float32Array.from(this.layout.positions));
    const targets = new Map<number, [number, number]>();
    for (let i = 0; i < this.nodes.length; i++) targets.set(i, [positions[i * 2], positions[i * 2 + 1]]);
    // Nothing is pinned to its old place any more — the tree decides where
    // everything goes, including whatever the reader had dragged aside.
    this.pinned.clear();
    this.arranged = new Set(targets.keys());
    this.frameArrangement(targets);
    this.beginTween(targets);
    return true;
  }

  /** Bring a node to the middle of the canvas without changing the zoom. */
  private centerOn(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    const pos = this.layout.positions;
    const k = this.view.k;
    this.userMoved = true; // a deliberate move; the auto-fit must not undo it
    this.glideTo({ k, x: this.width / 2 - pos[i * 2] * k, y: this.height / 2 - pos[i * 2 + 1] * k });
  }

  focus(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    const pos = this.layout.positions;
    const k = Math.max(this.view.k, 1.4);
    this.glideTo({ k, x: this.width / 2 - pos[i * 2] * k, y: this.height / 2 - pos[i * 2 + 1] * k });
    this.select(id);
  }

  firstMatch(): SimNode | undefined {
    const q = this.query.toLowerCase();
    return this.nodes.find((n) => !this.hiddenTypes[n.type] && n.name.toLowerCase().includes(q));
  }

  reheat(): void {
    this.layout.reheat(0.6);
  }

  /** The radii the layout is using, so a caller computing an exact layout sizes
   * its rings from the same numbers the renderer draws. */
  get radii(): Float32Array {
    return Float32Array.from(this.nodes, (n) => n.r);
  }

  /** Adopt an exact layout (tree, radial, layered) in place of the simulation. */
  useStaticPositions(positions: Float32Array): void {
    this.layout.setStatic(positions);
    this.geomCache = null;
    this.stamp++;
    this.dirty = true;
  }

  /** Ids currently on the canvas, in render order — the analysis works over what
   * is shown, never over rows that were grouped or filtered away. */
  get visibleIds(): string[] {
    return this.nodes.map((n) => n.id);
  }

  /* --------------------------------------------------------------- picking -- */

  private buildGrid(): void {
    if (this.gridStamp === this.stamp) return;
    this.gridStamp = this.stamp;
    this.grid.clear();
    const pos = this.layout.positions;
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.hiddenTypes[this.nodes[i].type]) continue;
      const key = this.cellKey(pos[i * 2], pos[i * 2 + 1]);
      const cell = this.grid.get(key);
      if (cell) cell.push(i);
      else this.grid.set(key, [i]);
    }
  }

  /** Two 16-bit cell coordinates packed into one number — a numeric key hashes far
   * faster than the `"x,y"` string it replaces, and this runs 26k times. */
  private cellKey(x: number, y: number): number {
    const cx = Math.floor(x / GRID_CELL) & 0xffff;
    const cy = Math.floor(y / GRID_CELL) & 0xffff;
    return (cx << 16) | cy;
  }

  private nodeAt(wx: number, wy: number): number {
    this.buildGrid();
    const pos = this.layout.positions;
    // A generous pick radius when zoomed out, so a two-pixel dot is still clickable.
    const slack = Math.max(0, 6 / this.view.k);
    let best = -1;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.grid.get(this.cellKey(wx + dx * GRID_CELL, wy + dy * GRID_CELL));
        if (!cell) continue;
        for (const i of cell) {
          const ex = pos[i * 2] - wx;
          const ey = pos[i * 2 + 1] - wy;
          const d = ex * ex + ey * ey;
          const reach = sizedFor(this.nodes[i].shape, this.nodes[i].r) + slack;
          if (d <= reach * reach && d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }

  /**
   * The edge nearest a point, within a few pixels of it.
   *
   * Measured against the straight chord rather than the drawn curve: the bow is
   * ten world units at its deepest, well inside the pick radius, and solving the
   * quadratic for every one of fourteen thousand edges to gain that precision
   * would cost more than the answer is worth. Hidden edges are not pickable, so
   * what you can click is exactly what you can see.
   */
  private edgeAt(wx: number, wy: number): SimEdge | null {
    const pos = this.layout.positions;
    const reach = 6 / this.view.k;
    let best: SimEdge | null = null;
    let bestD = reach * reach;
    for (const e of this.edges) {
      if (this.hiddenTypes[this.nodes[e.s].type] || this.hiddenTypes[this.nodes[e.t].type]) continue;
      if (this.hiddenRels[chipKey(e.relation)]) continue;
      const ax = pos[e.s * 2], ay = pos[e.s * 2 + 1];
      const bx = pos[e.t * 2], by = pos[e.t * 2 + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      // Clamped projection: the nearest point on the SEGMENT, not the infinite line.
      const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / len2));
      const ex = ax + dx * t - wx;
      const ey = ay + dy * t - wy;
      const d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.k,
      y: (clientY - rect.top - this.view.y) / this.view.k,
    };
  }

  /* ---------------------------------------------------------------- events -- */

  private bindPointer(): void {
    let drag: { i: number } | null = null;
    let pan: { x: number; y: number } | null = null;
    let moved = false;

    this.canvas.addEventListener("pointerdown", (ev) => {
      this.canvas.setPointerCapture(ev.pointerId);
      moved = false;
      if (this.jumpFromMinimap(ev)) { pan = null; drag = null; return; }
      const w = this.toWorld(ev.clientX, ev.clientY);
      const hit = this.nodeAt(w.x, w.y);
      if (hit >= 0) {
        drag = { i: hit };
        // Moving a node is taking charge of the picture: the camera stops
        // second-guessing where the reader wants to be looking.
        this.userMoved = true;
        this.dragMoved(hit, w.x, w.y);
      } else {
        pan = { x: ev.clientX - this.view.x, y: ev.clientY - this.view.y };
      }
    });

    this.canvas.addEventListener("pointermove", (ev) => {
      if (drag) {
        moved = true;
        const w = this.toWorld(ev.clientX, ev.clientY);
        this.dragMoved(drag.i, w.x, w.y);
        return;
      }
      if (pan) {
        moved = true;
        this.userMoved = true;
        this.target = null;
        this.view.x = ev.clientX - pan.x;
        this.view.y = ev.clientY - pan.y;
        this.dirty = true;
        return;
      }
      this.queueHover(ev.clientX, ev.clientY);
    });

    const end = (ev: PointerEvent): void => {
      if (drag && moved) {
        // Sticky. A force layout that yanks a node back the instant you let go
        // makes the graph feel like it is arguing with you — and the reason to
        // drag a node at all is usually to put it somewhere and read it there.
        // Double-click releases it back to the simulation.
        this.pinned.add(drag.i);
        this.dirty = true;
      } else if (drag) {
        // Select only. Drilling used to happen on this same click, which meant a
        // module bubble could never be *looked at* — the graph was replaced before
        // its neighbourhood could be shown. Opening it is a double-click, the way
        // opening a folder always has been.
        const id = this.nodes[drag.i].id;
        this.select(id);
        // …with a modifier, also make it the root everything else hangs off.
        if (ev.ctrlKey || ev.metaKey) this.onOrbit(id);
      } else if (pan && !moved) {
        // Nothing under the pointer that was a node — try the edges before
        // treating it as a click on empty canvas.
        const w = this.toWorld(ev.clientX, ev.clientY);
        const edge = this.edgeAt(w.x, w.y);
        if (edge) this.selectEdge(edge);
        else { this.selectEdge(null); this.select(null); }
      }
      drag = null;
      pan = null;
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener("pointerleave", () => this.setHover(-1));

    // Double-click hands a node back to the simulation; on empty canvas, all of
    // them — otherwise a graph someone has arranged has no way back.
    this.canvas.addEventListener("dblclick", (ev) => {
      const w = this.toWorld(ev.clientX, ev.clientY);
      const hit = this.nodeAt(w.x, w.y);
      if (hit >= 0) {
        const node = this.nodes[hit];
        // A bubble is a place, not a symbol: double-clicking it means "go in".
        if (node.type === "group" && node.path) { this.onDrill(node.path); return; }
        if (!this.pinned.delete(hit)) return;
        this.layout.fix(hit, null, null);
      } else {
        if (this.pinned.size === 0) return;
        for (const i of this.pinned) this.layout.fix(i, null, null);
        this.pinned.clear();
      }
      // An exact layout has no simulation to hand anything back to, and restarting
      // one would trade the arrangement the reader is looking at for a different
      // picture entirely. Unpinning is the whole of the answer there.
      if (!this.layout.isStatic) this.layout.reheat(0.3);
      this.dirty = true;
    });

    this.canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      this.userMoved = true;
      this.target = null;
      const rect = this.canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const k = this.clampK(this.view.k * Math.exp(-ev.deltaY * 0.0016));
      this.view.x = px - (px - this.view.x) * (k / this.view.k);
      this.view.y = py - (py - this.view.y) * (k / this.view.k);
      this.view.k = k;
      this.dirty = true;
    }, { passive: false });
  }

  /** A press inside the minimap centres the camera there instead of panning the
   * canvas underneath it. Returns true when it consumed the event. */
  private jumpFromMinimap(ev: PointerEvent): boolean {
    const m = this.minimap;
    if (!m) return false;
    const rect = this.canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    if (px < m.x0 || px > m.x0 + m.w || py < m.y0 || py > m.y0 + m.h) return false;
    const wx = m.cx + (px - m.x0 - m.w / 2) / m.scale;
    const wy = m.cy + (py - m.y0 - m.h / 2) / m.scale;
    this.userMoved = true;
    this.glideTo({ k: this.view.k, x: this.width / 2 - wx * this.view.k, y: this.height / 2 - wy * this.view.k });
    return true;
  }

  /** One hit-test per frame at most. Pointermove fires far faster than 60Hz, and
   * each test can rebuild the grid. */
  private queueHover(clientX: number, clientY: number): void {
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      const w = this.toWorld(clientX, clientY);
      this.setHover(this.nodeAt(w.x, w.y));
    });
  }

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.canvas.style.cursor = i >= 0 ? "pointer" : "grab";
    if (i < 0) {
      this.tip.hidden = true;
    } else {
      const n = this.nodes[i];
      this.tip.textContent = `${n.name} · ${n.type}`;
      this.tip.hidden = false;
      const pos = this.layout.positions;
      this.tip.style.left = `${pos[i * 2] * this.view.k + this.view.x}px`;
      this.tip.style.top = `${pos[i * 2 + 1] * this.view.k + this.view.y - n.r * this.view.k - 10}px`;
    }
    this.dirty = true;
  }

  /* ----------------------------------------------------------------- paint -- */

  private loop(): void {
    const run = (): void => {
      if (this.stepTween()) this.dirty = true;
      if (this.stepCamera()) this.dirty = true;
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
      this.frame = requestAnimationFrame(run);
    };
    this.frame = requestAnimationFrame(run);
  }

  private draw(): void {
    const ctx = this.ctx;
    const { x, y, k } = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.theme.canvas;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.translate(x, y);
    ctx.scale(k, k);

    const pos = this.layout.positions;
    const sel = this.selected === null ? -1 : this.index.get(this.selected) ?? -1;
    const q = this.query.toLowerCase();
    // A tween moves positions every frame just as the layout does, so it
    // invalidates the built geometry just as often and needs the same cheap pass.
    if ((this.layout.hot || this.tween.length > 0) && this.nodes.length > DRAFT_MIN_NODES) {
      this.drawDraft(pos, k);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawMinimap(pos);
      return;
    }

    const geom = this.ensureGeometry(pos, sel, q, k);
    const padEarly = 40 / k;
    const ex0 = -x / k - padEarly, ey0 = -y / k - padEarly;
    const ex1 = ex0 + this.width / k + padEarly * 2, ey1 = ey0 + this.height / k + padEarly * 2;
    const onScreenEarly = (i: number): boolean => {
      const px = pos[i * 2], py = pos[i * 2 + 1];
      return px > ex0 && px < ex1 && py > ey0 && py < ey1;
    };

    // Edges under nodes, each bucket one stroke. The width floor is applied here
    // rather than baked into the path so zooming never invalidates the cache.
    const minWidth = MIN_EDGE_PX / k;
    ctx.lineCap = "round";
    for (const b of geom.edges) {
      ctx.strokeStyle = rgba(b.color, b.alpha);
      ctx.lineWidth = Math.max(b.width, minWidth);
      if (b.dash.length) ctx.setLineDash(b.dash.map((d) => d / k));
      ctx.stroke(b.path);
      if (b.dash.length) ctx.setLineDash([]);
    }
    this.paintGlow(pos, k, onScreenEarly);
    // Fill, then cut each shape out of its neighbours with a stroke in the canvas
    // colour. Sixty-six adjacent hues touching edge to edge read as one continuous
    // mass; a hairline of background between them is what makes them countable.
    // Screen-width, so the separation is the same whatever the zoom.
    const border = BORDER_PX / k;
    for (const b of geom.nodes) {
      ctx.fillStyle = rgba(b.color, b.alpha);
      ctx.fill(b.path);
      if (b.alpha > 0.3) {
        ctx.strokeStyle = rgba(this.theme.canvas, Math.min(1, b.alpha + 0.1));
        ctx.lineWidth = border;
        ctx.stroke(b.path);
      }
    }

    if (geom.arrows) {
      ctx.fillStyle = rgba(this.theme.edge, 0.6);
      for (const e of geom.arrows) this.arrowHead(pos, e, 1);
    }
    this.paintFocus(pos, geom.focused, k);
    if (this.selectedEdge) this.paintPickedEdge(pos, this.selectedEdge, k);
    this.paintRings(pos, sel, k);

    // World-space viewport, padded by a node's worth of slack so nothing pops in.
    // Only the per-item work that is genuinely expensive — glyph runs — is culled;
    // the batched paths are left to the rasteriser, which clips far more cheaply
    // than a 26k-iteration loop in JavaScript can.
    const pad = 40 / k;
    const vx0 = -x / k - pad;
    const vy0 = -y / k - pad;
    const vx1 = vx0 + this.width / k + pad * 2;
    const vy1 = vy0 + this.height / k + pad * 2;
    const onScreen = (i: number): boolean => {
      const px = pos[i * 2], py = pos[i * 2 + 1];
      return px > vx0 && px < vx1 && py > vy0 && py < vy1;
    };
    const shown = (i: number): boolean => !this.hiddenTypes[this.nodes[i].type];

    this.drawLabels(pos, sel, q, k, onScreen, shown);
    if (k >= BADGE_MIN_K && this.showOwners) this.drawBadges(pos, k, onScreen, shown);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawMinimap(pos);
  }

  /**
   * A cheap frame, for while the layout is still moving.
   *
   * Every position update invalidates the built geometry, so a settling graph pays
   * the full rebuild — 8,625 arcs and 14,000 quadratic curves — on every frame the
   * worker posts, and the whole page drops to the layout's update rate. Nobody is
   * reading edge grammar or node labels off a graph that is still sliding around,
   * so while it moves this draws squares and straight lines: no trigonometry, no
   * curves, no text, no arrowheads, one stroke and a fill per colour. The moment it
   * settles, the real renderer takes over and the picture snaps into detail.
   */
  private drawDraft(pos: Float32Array, k: number): void {
    const ctx = this.ctx;
    const edges = new Path2D();
    for (const e of this.edges) {
      if (this.hiddenTypes[this.nodes[e.s].type] || this.hiddenTypes[this.nodes[e.t].type]) continue;
      if (this.hiddenRels[chipKey(e.relation)]) continue;
      edges.moveTo(pos[e.s * 2], pos[e.s * 2 + 1]);
      edges.lineTo(pos[e.t * 2], pos[e.t * 2 + 1]);
    }
    ctx.strokeStyle = rgba(this.theme.edge, 0.34);
    ctx.lineWidth = Math.max(1, MIN_EDGE_PX / k);
    ctx.stroke(edges);

    const buckets = new Map<string, Path2D>();
    const minR = MIN_NODE_PX / k;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (this.hiddenTypes[n.type]) continue;
      let path = buckets.get(n.group);
      if (!path) { path = new Path2D(); buckets.set(n.group, path); }
      // A square, not a circle: at this size the difference is invisible and `rect`
      // costs none of the trigonometry `arc` does.
      const r = sizedFor(n.shape, Math.max(n.r, minR));
      path.rect(pos[i * 2] - r, pos[i * 2 + 1] - r, r * 2, r * 2);
    }
    for (const [group, path] of buckets) {
      ctx.fillStyle = rgba(this.theme.groups.get(group) ?? this.theme.edge, 0.9);
      ctx.fill(path);
    }
  }

  /**
   * Rebuild the batched geometry, but only when something it depends on changed.
   *
   * A settled graph that is being panned or zoomed changes no world coordinate, so
   * the paths from the previous frame are still correct — and rebuilding them was
   * the whole cost of a pan (26fps zoomed out, where nothing is culled). The zoom
   * enters the key only as a coarse bucket, because the one thing `k` changes about
   * the geometry is the minimum on-screen node radius baked into each arc.
   */
  private ensureGeometry(pos: Float32Array, sel: number, q: string, k: number):
  { edges: Bucket[]; nodes: Bucket[]; focused: { e: SimEdge; role: "out" | "in" }[]; arrows: SimEdge[] | null } {
    const zoomBucket = Math.round(Math.log(k) / Math.log(1.3));
    const key = [
      this.stamp, sel, q, zoomBucket, this.spotlight ? this.spotlight.size : -1, this.spotVersion,
      Object.keys(this.hiddenTypes).filter((t) => this.hiddenTypes[t]).sort().join(","),
      Object.keys(this.hiddenRels).filter((r) => this.hiddenRels[r]).sort().join(","),
    ].join("|");
    if (this.geomCache && this.geomKey === key) return this.geomCache;
    this.geomKey = key;
    this.geomCache = {
      ...this.buildEdges(pos, sel, q, k),
      nodes: this.buildNodes(pos, sel, q, k),
    };
    return this.geomCache;
  }

  /**
   * Edges, bucketed by final appearance so the whole graph is a handful of strokes.
   *
   * Focused edges are collected instead of batched: they need arrowheads, a verb
   * label and their own colour, and there are never more than a node's degree of
   * them, so drawing those one at a time costs nothing.
   */
  private buildEdges(pos: Float32Array, sel: number, q: string, k: number):
  { edges: Bucket[]; focused: { e: SimEdge; role: "out" | "in" }[]; arrows: SimEdge[] | null } {
    const buckets = new Map<string, Bucket>();
    const focused: { e: SimEdge; role: "out" | "in" }[] = [];
    const arrows: SimEdge[] = [];

    for (const e of this.edges) {
      if (this.hiddenTypes[this.nodes[e.s].type] || this.hiddenTypes[this.nodes[e.t].type]) continue;
      if (this.hiddenRels[chipKey(e.relation)]) continue;

      const role = sel < 0 ? "none" : e.s === sel ? "out" : e.t === sel ? "in" : "far";
      if (role === "out" || role === "in") { focused.push({ e, role }); continue; }
      let color = this.theme.edge;

      const fam = famOf(e.relation);
      let width = 1.3, alpha = 0.5, dash: number[] = [];
      if (fam === "structure") { width = 2.4; alpha = 0.32; }
      else if (fam === "dependency") { width = 1.5; alpha = 0.55; }
      else if (fam === "contract") { alpha = 0.55; }
      // An include is scaffolding, not behaviour: long dashes, low contrast, so it
      // never competes with a call for attention when both layers are shown.
      else if (fam === "file") { dash = [9, 6]; width = 1.1; alpha = 0.30; }
      else { dash = [2, 5]; width = 1.2; alpha = 0.28; }
      if (e.confidence === "inferred") dash = [5, 4];
      // A bundle stands for many edges; log-scaled, because a 400-reference rope
      // next to a 4-reference thread on a linear scale is a rope and nothing else.
      if (e.weight && e.weight > 1) { width += Math.min(7, Math.log2(e.weight) * 1.5); alpha = Math.min(0.85, alpha + 0.2); }
      if (q) alpha = 0.12;
      if (role === "far") alpha = 0.06;
      if (this.spotlight) {
        const lit = this.spotlight.has(this.nodes[e.s].id) && this.spotlight.has(this.nodes[e.t].id);
        if (lit) { color = this.theme.in; alpha = 0.95; width = Math.max(width, 2.4); }
        else alpha = 0.05;
      }

      const bucketKey = `${width}|${alpha}|${dash.join(",")}|${color}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = { path: new Path2D(), width, dash, color, alpha };
        buckets.set(bucketKey, bucket);
      }
      this.edgePath(bucket.path, pos, e);
      if (sel < 0 && (fam === "dependency" || fam === "contract")) arrows.push(e);
    }

    return {
      edges: [...buckets.values()],
      focused,
      // Arrowheads are a fill each and illegible when small, so they are dropped
      // when zoomed out or when there are simply too many to be worth the frame.
      arrows: k >= ARROW_MIN_K && arrows.length <= MAX_ARROWS ? arrows : null,
    };
  }

  /** A node's colour: its module. Falls back to the kind palette for a graph with
   * no paths at all (a blast export), where "which directory" means nothing. */
  private colorOf(n: SimNode): string {
    return this.theme.groups.get(n.group) ?? this.theme.node[n.type] ?? this.theme.edge;
  }

  /** Nodes, filled per colour. Seven `fill()` calls for 26k circles. */
  private buildNodes(pos: Float32Array, sel: number, q: string, k: number): Bucket[] {
    const buckets = new Map<string, Bucket>();
    const minR = MIN_NODE_PX / k;

    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (this.hiddenTypes[n.type]) continue;
      let alpha = 0.92;
      if (q && !n.name.toLowerCase().includes(q)) alpha *= 0.22;
      if (sel >= 0 && i !== sel && !this.neighbors.has(i)) alpha = Math.min(alpha, 0.2);
      if (this.spotlight) alpha = this.spotlight.has(n.id) ? 0.98 : 0.07;
      const a = Math.round(alpha * 20) / 20; // quantised: keeps the bucket count tiny
      // Colour by group, outline by kind — one bucket per pairing, each still a
      // single fill however many nodes land in it.
      const key = `${n.group}|${n.shape}|${a}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { path: new Path2D(), color: this.colorOf(n), alpha: a, width: 0, dash: [] };
        buckets.set(key, bucket);
      }
      shapePath(bucket.path, n.shape, pos[i * 2], pos[i * 2 + 1], Math.max(n.r, minR));
    }
    // Ascending alpha: whatever is lit is drawn last and therefore on top. With a
    // selection, the faded remainder would otherwise scribble over the very
    // neighbourhood the selection exists to isolate.
    return [...buckets.values()].sort((a, b) => a.alpha - b.alpha);
  }

  /**
   * The whole graph in the corner, with a box showing where you are in it.
   *
   * Zoomed in on a graph this size there is no other way to know whether you are
   * looking at the middle of everything or one forgotten corner. Drawn in screen
   * space after the world transform is dropped, on the same canvas — a second
   * canvas element would need its own resize, DPR and theme handling for a
   * picture that is 150 pixels wide.
   *
   * It draws from a cached down-sampled copy of the positions rather than all
   * 26k, because it repaints on every pan.
   */
  private drawMinimap(pos: Float32Array): void {
    if (this.nodes.length < MINIMAP_MIN_NODES || this.width < 520) return;
    const ctx = this.ctx;
    const w = MINIMAP_W;
    const h = Math.round(w * (this.height / this.width));
    const x0 = this.width - w - 12;
    const y0 = 12;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const px = pos[i * 2], py = pos[i * 2 + 1];
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const scale = Math.min(w, h) / (span * 1.06);
    const toX = (v: number) => x0 + w / 2 + (v - (minX + maxX) / 2) * scale;
    const toY = (v: number) => y0 + h / 2 + (v - (minY + maxY) / 2) * scale;

    ctx.fillStyle = rgba(this.theme.panel, 0.82);
    ctx.strokeStyle = rgba(this.theme.edge, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.fill();
    ctx.stroke();

    // Every Nth node: the shape of the graph, not a census of it.
    const stride = Math.max(1, Math.floor(this.nodes.length / MINIMAP_SAMPLES));
    ctx.fillStyle = rgba(this.theme.ink, 0.45);
    for (let i = 0; i < this.nodes.length; i += stride) {
      if (this.hiddenTypes[this.nodes[i].type]) continue;
      ctx.fillRect(toX(pos[i * 2]), toY(pos[i * 2 + 1]), 1.3, 1.3);
    }

    // Where the camera is: the world rectangle currently on screen.
    const k = this.view.k;
    const vx = toX(-this.view.x / k);
    const vy = toY(-this.view.y / k);
    const vw = (this.width / k) * scale;
    const vh = (this.height / k) * scale;
    ctx.strokeStyle = this.theme.in;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(
      Math.max(x0, vx), Math.max(y0, vy),
      Math.min(vw, x0 + w - Math.max(x0, vx)),
      Math.min(vh, y0 + h - Math.max(y0, vy)),
    );
    this.minimap = { x0, y0, w, h, scale, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  /**
   * A soft halo behind the best-connected nodes.
   *
   * Not decoration: in a field of same-sized dots the hubs are the only thing
   * worth looking at first, and radius alone caps out too early to distinguish a
   * degree-8 node from a degree-60 one. Capped and gated on zoom, because a glow
   * per node is a radial gradient per node.
   */
  private paintGlow(pos: Float32Array, k: number, onScreen: (i: number) => boolean): void {
    // Only where finding a hub is actually hard. On a few dozen bubbles the halos
    // overlap into a wash that erases exactly the borders the colours depend on —
    // and with that few nodes nobody needed help spotting the big ones anyway.
    if (this.hubIndices.length === 0 || this.nodes.length < GLOW_MIN_NODES) return;
    const ctx = this.ctx;
    for (const i of this.hubIndices) {
      if (!onScreen(i) || this.hiddenTypes[this.nodes[i].type]) continue;
      if (this.spotlight && !this.spotlight.has(this.nodes[i].id)) continue;
      const n = this.nodes[i];
      const x = pos[i * 2], y = pos[i * 2 + 1];
      const drawn = sizedFor(n.shape, Math.max(n.r, MIN_NODE_PX / k));
      const r = drawn * 1.9;
      const g = ctx.createRadialGradient(x, y, drawn * 0.8, x, y, r);
      const color = this.colorOf(n);
      g.addColorStop(0, rgba(color, 0.16));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The selected and hovered outlines — two circles, redrawn every frame because
   * hover changes far more often than the geometry does. */
  private paintRings(pos: Float32Array, sel: number, k: number): void {
    const ctx = this.ctx;
    // The outline follows the node's own shape. A circle drawn around a triangle
    // says the selection is somewhere in that area rather than on that node, and
    // on a crowded canvas that is the difference between an answer and a hint.
    const ring = (i: number, color: string, alpha: number, pad: number, width: number): void => {
      // Bounds-checked as well as cleared on swap: a ring is drawn from state the
      // reader controls (hover, pins, selection), and a stale index there must
      // skip a ring, never take the frame down with it.
      const n = this.nodes[i];
      if (i < 0 || n === undefined || this.hiddenTypes[n.type]) return;
      const path = new Path2D();
      shapePath(path, n.shape, pos[i * 2], pos[i * 2 + 1], n.r + pad);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = Math.max(width, width / k);
      ctx.stroke(path);
    };
    for (const i of this.pinned) ring(i, this.theme.out, 0.7, 3, 1.4);
    if (sel >= 0) ring(sel, this.colorOf(this.nodes[sel]), 0.55, 5, 1.6);
    if (this.hover >= 0 && this.hover !== sel) ring(this.hover, this.theme.ink, 0.35, 4, 1.2);
  }

  /** The one edge the reader clicked, drawn over everything so the panel beside it
   * is unambiguously about THIS rope and not its neighbour. */
  private paintPickedEdge(pos: Float32Array, e: SimEdge, k: number): void {
    const ctx = this.ctx;
    const path = new Path2D();
    this.edgePath(path, pos, e);
    ctx.strokeStyle = this.theme.out;
    ctx.lineWidth = Math.max(3, 3 / k);
    ctx.stroke(path);
    ctx.fillStyle = this.theme.out;
    this.arrowHead(pos, e, 1.4);
  }

  /**
   * Focused edges: own colour, arrowhead, and the relationship spelled out from
   * the selected node's point of view.
   *
   * A mutual pair — the same verb each way — is drawn once with a head at both
   * ends. The reader asked "what does this touch"; two ropes between the same two
   * bubbles answer it twice.
   */
  private paintFocus(pos: Float32Array, focused: { e: SimEdge; role: "out" | "in" }[], k: number): void {
    if (focused.length === 0) return;
    const ctx = this.ctx;

    // Pair up opposite edges of the same relation: they become one rope.
    const byPair = new Map<string, { e: SimEdge; role: "out" | "in" }>();
    const draw: { e: SimEdge; role: "out" | "in"; mutual: boolean }[] = [];
    for (const f of focused) {
      const other = f.role === "out" ? f.e.t : f.e.s;
      const key = `${other}|${f.e.relation}`;
      const twin = byPair.get(key);
      if (twin && twin.role !== f.role) {
        const slot = draw.find((d) => d.e === twin.e);
        if (slot) { slot.mutual = true; continue; }
      }
      byPair.set(key, f);
      draw.push({ ...f, mutual: false });
    }

    for (const { e, role, mutual } of draw) {
      const color = role === "out" ? this.theme.out : this.theme.in;
      const path = new Path2D();
      this.edgePath(path, pos, e);
      // A mutual edge belongs to neither direction, so it takes the neutral ink
      // rather than claiming to be one of them.
      ctx.strokeStyle = rgba(mutual ? this.theme.ink : color, 0.95);
      ctx.lineWidth = Math.max(2.2, MIN_EDGE_PX / k);
      if (e.confidence === "inferred") ctx.setLineDash([5 / k, 4 / k]);
      ctx.stroke(path);
      ctx.setLineDash([]);
      ctx.fillStyle = mutual ? this.theme.ink : color;
      this.arrowHead(pos, e, 1.25, mutual);
    }

    // No zoom gate here, unlike the general labels: a focus ring has a handful of
    // edges and naming them is the entire point of having focused.
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const { e, role, mutual } of draw) {
      const [sx, sy, tx, ty, ux, uy] = this.edgeEnds(pos, e);
      const [mx, my] = this.bowPoint(sx, sy, tx, ty, ux, uy, e.bow);
      // The midpoint of the CURVE, not of the chord: at B(0.5) the label sits on
      // the rope it names instead of floating beside it.
      const lx = (sx + 2 * mx + tx) / 4;
      const ly = (sy + 2 * my + ty) / 4;
      const verb = mutual ? `${verbFor(e.relation, "out")} both ways` : verbFor(e.relation, role);
      const text = e.weight && e.weight > 1 ? `${verb} ×${e.weight}` : verb;
      this.labelPlate(text, lx, ly, k);
      ctx.fillStyle = mutual ? this.theme.ink : role === "out" ? this.theme.out : this.theme.in;
      ctx.fillText(text, lx, ly);
    }
  }

  /**
   * The canvas-coloured plate a label sits on.
   *
   * A stroked halo is the cheap way to keep text off a line, and it fails exactly
   * where it matters: over a thick bundle, or where two edges cross, the halo is
   * thinner than what it has to hide and the text turns to mush. A filled plate —
   * the way Excalidraw labels an arrow — is opaque by construction, so the words
   * read at any zoom over anything.
   */
  private labelPlate(text: string, x: number, y: number, k: number): void {
    const ctx = this.ctx;
    const w = ctx.measureText(text).width;
    const padX = 5 / k, padY = 3.5 / k;
    const h = LABEL_SIZE / k;
    const r = Math.min(4 / k, h / 2 + padY);
    const left = x - w / 2 - padX, top = y - h / 2 - padY;
    const width = w + padX * 2, height = h + padY * 2;
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.arcTo(left + width, top, left + width, top + height, r);
    ctx.arcTo(left + width, top + height, left, top + height, r);
    ctx.arcTo(left, top + height, left, top, r);
    ctx.arcTo(left, top, left + width, top, r);
    ctx.closePath();
    ctx.fillStyle = rgba(this.theme.canvas, 0.92);
    ctx.fill();
  }

  /**
   * How much room node `i` actually takes on screen, in world units.
   *
   * `n.r` is the radius a CIRCLE of this weight would have; every other shape is
   * grown from it to cover the same area, reaching 1.55x further out for a
   * triangle. Spacing computed from `n.r` therefore under-reserves for exactly
   * the shapes that need the most, which is why arranged neighbours still landed
   * on top of each other. Everything that reasons about room — the ring, the
   * eviction band, the frame — reads this instead.
   */
  private roomOf(i: number): number {
    return sizedFor(this.nodes[i].shape, this.nodes[i].r);
  }

  /**
   * Move node `i` to `(x, y)` under the reader's finger, and keep the graph from
   * stacking up underneath it.
   *
   * A force layout does this itself — collision is one of its forces. An exact
   * layout has no simulation running, so before this a bubble could be dropped
   * squarely on top of another and simply stay there. Restarting the simulation
   * for the occasion is not the fix either: measured on a real graph it moved all
   * 61 nodes and threw one 1,900 units, i.e. it answered "let me put this here"
   * with a different picture.
   *
   * So the collision is resolved locally instead: whatever the dragged node lands
   * on is pushed just far enough to clear it, and if that node in turn lands on
   * something, so is that — a couple of levels deep, which is all it takes on a
   * layout that had no overlaps to begin with. Everything else stays exactly
   * where the reader last saw it.
   */
  private dragMoved(i: number, x: number, y: number): void {
    this.layout.fix(i, x, y);
    if (!this.layout.isStatic) { this.layout.reheat(0.25); return; }
    this.separate(i);
    this.stamp++;
    this.dirty = true;
  }

  /**
   * Push everything overlapping `i` clear of it, and whatever those then overlap.
   *
   * A queue rather than fixed-depth recursion: two levels left the odd pair of
   * bystanders sitting on each other after a long drag through a crowd. Each node
   * may be pushed a few times and no more, which is what stops A and B trading
   * places forever, and the whole cascade is capped so a drag can never cost more
   * than a frame.
   */
  private separate(from: number): void {
    const pos = this.layout.positions;
    const pushes = new Map<number, number>();
    const queue = [from];
    let budget = SEPARATION_BUDGET;

    while (queue.length > 0 && budget > 0) {
      const i = queue.shift()!;
      const ri = this.roomOf(i);
      for (let j = 0; j < this.nodes.length; j++) {
        // A pinned node is moved too. Pinning says "leave this where I put it",
        // which the layout honours; it cannot mean "let other nodes be dropped on
        // top of it", because then dragging one bubble onto a pinned one left them
        // overlapping with nothing able to fix it.
        if (j === i || j === from || this.hiddenTypes[this.nodes[j].type]) continue;
        if ((pushes.get(j) ?? 0) >= MAX_PUSHES) continue;
        let dx = pos[j * 2] - pos[i * 2];
        let dy = pos[j * 2 + 1] - pos[i * 2 + 1];
        let d = Math.hypot(dx, dy);
        const want = ri + this.roomOf(j) + SEPARATION_GAP;
        if (d >= want) continue;
        // Exactly on top: no bearing to push along, so take a deterministic one
        // rather than leaving the two welded together.
        if (d < 1e-3) { const a = (j * 2.39996) % (Math.PI * 2); dx = Math.cos(a); dy = Math.sin(a); d = 1; }
        pos[j * 2] = pos[i * 2] + (dx / d) * want;
        pos[j * 2 + 1] = pos[i * 2 + 1] + (dy / d) * want;
        this.layout.fix(j, pos[j * 2], pos[j * 2 + 1]);
        pushes.set(j, (pushes.get(j) ?? 0) + 1);
        queue.push(j);
        budget--;
        if (budget <= 0) break;
      }
    }
  }

  /** The selected node's index, or -1 — the same lookup the paint path does, kept
   * in one place so the trim and the ring agree about who is wearing one. */
  private selectedIndex(): number {
    return this.selected === null ? -1 : this.index.get(this.selected) ?? -1;
  }

  /**
   * How far an edge must stay clear of node `i`'s centre, along `angle`.
   *
   * The node's own outline, plus a fixed gap, plus the ring it is wearing if any:
   * an arrow that ends under the selection ring reads as ending inside the node,
   * which is the one thing the trim exists to prevent. Both ends use this, so an
   * edge sits the same distance off its source as off its target — the old
   * asymmetric `+2` / `+6` is what made the tail overlap while the head floated.
   */
  private clearanceOf(i: number, angle: number): number {
    const n = this.nodes[i];
    const ringed = i === this.selectedIndex() || i === this.hover || this.pinned.has(i);
    return radiusAt(n.shape, n.r, angle) + EDGE_GAP + (ringed ? RING_PAD : 0);
  }

  /** Trimmed endpoints and the unit vector between them — the geometry every edge
   * drawing step needs, computed once. */
  private edgeEnds(pos: Float32Array, e: SimEdge): [number, number, number, number, number, number] {
    const ax = pos[e.s * 2], ay = pos[e.s * 2 + 1];
    const bx = pos[e.t * 2], by = pos[e.t * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / d, uy = dy / d;
    const outward = Math.atan2(uy, ux);
    const ar = this.clearanceOf(e.s, outward);
    const br = this.clearanceOf(e.t, outward + Math.PI);
    return [ax + ux * ar, ay + uy * ar, bx - ux * br, by - uy * br, ux, uy];
  }

  /**
   * Give every edge between the same pair of nodes its own bow.
   *
   * Two modules joined by both a call bundle and an include bundle drew two
   * curves with the same constant bow — one exactly on top of the other, two
   * arrowheads in the same place and two labels in the same place, of which the
   * reader saw whichever was painted last. Fanning them apart is what makes the
   * second fact visible at all.
   *
   * Direction is part of the key on purpose: `a → b` and `b → a` bow to opposite
   * sides, so a mutual dependency reads as a lens rather than as one line.
   */
  private fanOut(): void {
    const lanes = new Map<string, SimEdge[]>();
    for (const e of this.edges) {
      const key = e.s < e.t ? `${e.s}|${e.t}` : `${e.t}|${e.s}`;
      const lane = lanes.get(key);
      if (lane) lane.push(e);
      else lanes.set(key, [e]);
    }
    for (const lane of lanes.values()) {
      if (lane.length === 1) { lane[0].bow = BOW; continue; }
      // Centred on the straight line, so a pair with two edges straddles it and a
      // pair with three keeps one down the middle.
      lane.forEach((e, i) => {
        const offset = (i - (lane.length - 1) / 2) * BOW_STEP;
        e.bow = (e.s === lane[0].s ? 1 : -1) * BOW + offset;
      });
    }
  }

  /** The control point of an edge's curve: the bow, applied perpendicular. */
  private bowPoint(sx: number, sy: number, tx: number, ty: number, ux: number, uy: number, bow: number):
  [number, number] {
    return [(sx + tx) / 2 - uy * bow, (sy + ty) / 2 + ux * bow];
  }

  private edgePath(path: Path2D, pos: Float32Array, e: SimEdge): void {
    const [sx, sy, tx, ty, ux, uy] = this.edgeEnds(pos, e);
    const [mx, my] = this.bowPoint(sx, sy, tx, ty, ux, uy, e.bow);
    path.moveTo(sx, sy);
    path.quadraticCurveTo(mx, my, tx, ty);
  }

  /** One arrowhead at `(hx, hy)`, pointing along `(dx, dy)`. */
  private headAt(hx: number, hy: number, dx: number, dy: number, scale: number): void {
    const ctx = this.ctx;
    const size = 6 * scale;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - dx * size + dy * size * 0.5, hy - dy * size - dx * size * 0.5);
    ctx.lineTo(hx - dx * size - dy * size * 0.5, hy - dy * size + dx * size * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Arrowheads for one edge: at the target always, and at the source too when
   * `bothEnds` — a mutual dependency drawn as one double-headed rope rather than
   * as two ropes the reader has to notice are a pair. Purely how it is drawn:
   * the two edges are still two edges, and the panel still names each.
   */
  private arrowHead(pos: Float32Array, e: SimEdge, scale: number, bothEnds = false): void {
    const [sx, sy, tx, ty, ux, uy] = this.edgeEnds(pos, e);
    const [mx, my] = this.bowPoint(sx, sy, tx, ty, ux, uy, e.bow);
    // Tangent at the curve's end, not the chord: the bow means they differ enough
    // for a chord-aligned head to sit visibly askew.
    const norm = (dx: number, dy: number): [number, number] => {
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      return [dx / d, dy / d];
    };
    const [hx, hy] = norm(tx - mx, ty - my);
    this.headAt(tx, ty, hx, hy, scale);
    if (bothEnds) {
      const [bx, by] = norm(sx - mx, sy - my);
      this.headAt(sx, sy, bx, by, scale);
    }
  }

  /**
   * Labels, rationed.
   *
   * Every glyph run is shaped, stroked for the halo and filled, so this is the one
   * place where drawing everything on screen would undo the rewrite. Selection,
   * neighbours and search hits are never rationed — they are what the reader is
   * actually looking at — and the remaining budget goes to the most connected
   * nodes, which are the ones worth naming in a hairball.
   */
  private drawLabels(
    pos: Float32Array, sel: number, q: string, k: number,
    onScreen: (i: number) => boolean, shown: (i: number) => boolean,
  ): void {
    const ctx = this.ctx;
    const always: number[] = [];
    const rest: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (!shown(i) || !onScreen(i)) continue;
      const n = this.nodes[i];
      // A node big enough on screen to hold its own name always gets one. This is
      // measured in PIXELS, not world units: a rolled-up module stays legible when
      // the whole graph is zoomed out to fit, which is exactly when its name is
      // most wanted — the old world-zoom gate blanked every label at that point.
      if (n.r * k >= INSIDE_LABEL_PX) always.push(i);
      else if (i === sel || this.neighbors.has(i) || (q && n.name.toLowerCase().includes(q))) always.push(i);
      // The zoom gate exists to stop thousands of glyph runs, so it should not
      // apply when there are only dozens: a rolled-up view of sixty-six modules
      // can name every one of them for less than a millisecond.
      else if ((k >= LABEL_MIN_K || this.nodes.length <= MAX_LABELS) && !q && sel < 0) rest.push(i);
    }
    if (rest.length > MAX_LABELS) {
      rest.sort((a, b) => this.nodes[b].deg - this.nodes[a].deg);
      rest.length = MAX_LABELS;
    }
    if (always.length > MAX_LABELS) always.sort((a, b) => this.nodes[b].r - this.nodes[a].r);
    const draw = always.length > MAX_LABELS ? always.slice(0, MAX_LABELS) : always.concat(rest);
    if (draw.length === 0) return;

    ctx.textAlign = "center";
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = this.theme.canvas;
    for (const i of draw) {
      const n = this.nodes[i];
      const x = pos[i * 2];
      // A name inside the thing it names, when the thing is big enough to hold it.
      // A bubble worth 1,200 symbols is a place on the map, and a place wears its
      // label on its face; only a dot too small to write on needs one hung beneath.
      // Fit to what THIS shape can hold, not to a circle: a diamond is full width
      // at exactly one height and pinches to nothing above and below, so a name
      // sized to its widest chord spills straight out of the corners.
      ctx.font = LABEL_FONT;
      const room = textWidthIn(n.shape, n.r);
      const size = Math.min(INSIDE_LABEL_MAX, LABEL_SIZE * (room / Math.max(1, ctx.measureText(n.name).width)));
      // Inside only when the shape is big enough on screen AND the name fits at a
      // readable size. Below that the label goes underneath, where it has the whole
      // canvas to be legible in, rather than overflowing an outline it cannot fit.
      const inside = n.r * this.view.k >= INSIDE_LABEL_PX && size >= INSIDE_LABEL_MIN;
      if (inside) {
        ctx.font = LABEL_FONT.replace(`${LABEL_SIZE}px`, `${size.toFixed(1)}px`);
        ctx.textBaseline = "middle";
        // Contrast against THIS bubble, not against the page. Sixty-six hues span
        // light and dark, and one fixed ink colour is unreadable on half of them.
        ctx.fillStyle = readableOn(this.colorOf(n));
        ctx.fillText(n.name, x, pos[i * 2 + 1]);
      } else {
        ctx.font = LABEL_FONT;
        ctx.textBaseline = "alphabetic";
        const y = pos[i * 2 + 1] + sizedFor(n.shape, n.r) + 15;
        ctx.strokeText(n.name, x, y);
        ctx.fillStyle = this.theme.ink;
        ctx.fillText(n.name, x, y);
      }
    }
  }

  /**
   * The contributor stack on a bubble: up to {@link MAX_BADGES} sets of initials,
   * then a `+N`, fanned out from the node's upper right.
   */
  private drawBadges(
    pos: Float32Array, k: number,
    onScreen: (i: number) => boolean, shown: (i: number) => boolean,
  ): void {
    const ctx = this.ctx;
    ctx.font = '700 7.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const owners = n.owners ?? [];
      if (owners.length === 0 || !shown(i) || !onScreen(i)) continue;
      const chips = [
        ...owners.slice(0, MAX_BADGES).map((o) => initials(o.handle ?? o.name)),
        ...(owners.length > MAX_BADGES ? [`+${owners.length - MAX_BADGES}`] : []),
      ];
      chips.forEach((text, j) => {
        // A 45° fan off the top-right, one radius out, so the stack never covers the
        // node's own colour and never collides with the name under it.
        const cx = pos[i * 2] + n.r * 0.72 + j * 13;
        const cy = pos[i * 2 + 1] - n.r * 0.72 + j * 8;
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fillStyle = this.theme.panel;
        ctx.fill();
        ctx.strokeStyle = this.theme.con;
        ctx.lineWidth = 1.2 / k;
        ctx.stroke();
        ctx.fillStyle = this.theme.con;
        ctx.fillText(text, cx, cy + 3);
      });
    }
  }
}
