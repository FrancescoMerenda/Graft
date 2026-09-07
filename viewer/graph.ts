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
import { type VizGraph, type VizEdge, type NodeOwner, famOf, REST, chipKey, colorToken, cvar } from "./data.js";
import { initials } from "./detail.js";
import { LayoutDriver } from "./sim.js";
import type { SimSpec } from "./sim-core.js";

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
}

interface SimEdge {
  s: number;
  t: number;
  relation: string;
  description?: string;
  confidence?: string;
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
const LABEL_FONT = '600 11.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Arrowheads cost a fill each and are illegible when small; past this many
 * on-screen edges they are dropped except on the focused ones. */
const ARROW_MIN_K = 0.9;
const MAX_ARROWS = 3000;

/** Owner badges are two circles and a glyph run each — prominent nodes only. */
const BADGE_MIN_K = 0.8;

/** Hit-test grid cell, in world units. Roughly three node diameters: big enough
 * that the grid stays small, small enough that a lookup scans a handful of nodes. */
const GRID_CELL = 96;

/** Resolved theme tokens. `cvar` is `getComputedStyle` under the hood — calling it
 * per node per frame was costing more than the drawing did. */
interface Theme {
  edge: string;
  canvas: string;
  ink: string;
  panel: string;
  con: string;
  out: string;
  in: string;
  node: Record<string, string>;
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

  private view = { x: 0, y: 0, k: 1 };
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

  private neighbors = new Set<number>();
  private hover = -1;
  private hoverQueued = false;

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

  selected: string | null = null;
  query = "";
  hiddenRels: Record<string, boolean> = {};
  hiddenTypes: Record<string, boolean> = {};
  /** The contributor badges on each bubble. A decoration, not a filter — toggling
   * it never changes which nodes are on the canvas. */
  showOwners = true;
  onSelect: (id: string | null) => void = () => {};

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
    this.layout.onFrame = () => { this.stamp++; this.dirty = true; };
    this.bindPointer();
    this.loop();
  }

  /* ------------------------------------------------------------------ data -- */

  /** Load (or morph into) a new dataset. Nodes keep their positions by id. */
  setData(graph: VizGraph, tab: "context" | "code"): void {
    this.tab = tab;
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
      const r = 11 + Math.min(13, d * 2.6);
      radii[i] = r;
      const prev = prevIndex.get(n.id);
      if (prev !== undefined && prevPos.length > prev * 2 + 1) {
        positions[i * 2] = prevPos[prev * 2];
        positions[i * 2 + 1] = prevPos[prev * 2 + 1];
      } else {
        // A disc, not a ring. Seeding every node on one circle is invisible when a
        // graph is small and connected, but a wiring graph this size is mostly
        // isolated symbols that no spring ever pulls inward — they stay exactly
        // where they were put, and the ring becomes the picture. `sqrt` keeps the
        // disc uniformly dense instead of piling everything at the centre.
        const angle = i * 2.399963; // golden angle: no radial banding
        const spread = (Math.min(W, H) / 3) * Math.sqrt((i + 0.5) / count);
        positions[i * 2] = W / 2 + Math.cos(angle) * spread;
        positions[i * 2 + 1] = H / 2 + Math.sin(angle) * spread;
      }
      return { id: n.id, name: n.name, type: n.type, owners: n.owners, deg: d, r };
    });

    this.index = new Map(this.nodes.map((n, i) => [n.id, i]));

    const links: number[] = [];
    const distances: number[] = [];
    this.edges = [];
    for (const e of graph.edges as VizEdge[]) {
      const s = this.index.get(e.source);
      const t = this.index.get(e.target);
      if (s === undefined || t === undefined) continue;
      this.edges.push({ s, t, relation: e.relation, description: e.description, confidence: e.confidence });
      links.push(s, t);
      distances.push(REST[famOf(e.relation)]);
    }

    const spec: SimSpec = {
      count,
      radii,
      links: Uint32Array.from(links),
      distances: Float32Array.from(distances),
      positions,
      width: W,
      height: H,
    };
    this.layout.setData(spec);
    this.restyle();
  }

  /* ----------------------------------------------------------------- style -- */

  private readTheme(): void {
    const types = ["file", "class", "function", "method", "interface", "type", "enum", "system", "concept", "api", "changed", "affected"];
    const node: Record<string, string> = {};
    for (const t of types) node[t] = cvar(colorToken(this.tab, t));
    this.theme = {
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
    this.dirty = true;
  }

  select(id: string | null): void {
    this.selected = id;
    this.restyle();
    this.onSelect(id);
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

  zoomBy(factor: number): void {
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const r = this.nodes[i].r;
      const x = pos[i * 2], y = pos[i * 2 + 1];
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const k = this.clampK(Math.min(this.width / w, this.height / h) * 0.92);
    this.view.k = k;
    this.view.x = this.width / 2 - ((minX + maxX) / 2) * k;
    this.view.y = this.height / 2 - ((minY + maxY) / 2) * k;
    this.dirty = true;
  }

  /** Center the view on a node and select it (used by search). */
  focus(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    const pos = this.layout.positions;
    this.view.k = Math.max(this.view.k, 1.4);
    this.view.x = this.width / 2 - pos[i * 2] * this.view.k;
    this.view.y = this.height / 2 - pos[i * 2 + 1] * this.view.k;
    this.select(id);
  }

  firstMatch(): SimNode | undefined {
    const q = this.query.toLowerCase();
    return this.nodes.find((n) => !this.hiddenTypes[n.type] && n.name.toLowerCase().includes(q));
  }

  reheat(): void {
    this.layout.reheat(0.6);
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
          const reach = this.nodes[i].r + slack;
          if (d <= reach * reach && d < bestD) { bestD = d; best = i; }
        }
      }
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
      const w = this.toWorld(ev.clientX, ev.clientY);
      const hit = this.nodeAt(w.x, w.y);
      if (hit >= 0) {
        drag = { i: hit };
        this.layout.fix(hit, w.x, w.y);
        this.layout.reheat(0.25);
      } else {
        pan = { x: ev.clientX - this.view.x, y: ev.clientY - this.view.y };
      }
    });

    this.canvas.addEventListener("pointermove", (ev) => {
      if (drag) {
        moved = true;
        const w = this.toWorld(ev.clientX, ev.clientY);
        this.layout.fix(drag.i, w.x, w.y);
        this.layout.reheat(0.25);
        return;
      }
      if (pan) {
        moved = true;
        this.view.x = ev.clientX - pan.x;
        this.view.y = ev.clientY - pan.y;
        this.dirty = true;
        return;
      }
      this.queueHover(ev.clientX, ev.clientY);
    });

    const end = (ev: PointerEvent): void => {
      if (drag) {
        this.layout.fix(drag.i, null, null);
        if (!moved) this.select(this.nodes[drag.i].id);
      } else if (pan && !moved) {
        this.select(null);
      }
      drag = null;
      pan = null;
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener("pointerleave", () => this.setHover(-1));

    this.canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
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
    const geom = this.ensureGeometry(pos, sel, q, k);

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
    for (const b of geom.nodes) {
      ctx.fillStyle = rgba(b.color, b.alpha);
      ctx.fill(b.path);
    }

    if (geom.arrows) {
      ctx.fillStyle = rgba(this.theme.edge, 0.6);
      for (const e of geom.arrows) this.arrowHead(pos, e, 1);
    }
    this.paintFocus(pos, geom.focused, k);
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

    if (k >= LABEL_MIN_K || sel >= 0 || q) this.drawLabels(pos, sel, q, k, onScreen, shown);
    if (k >= BADGE_MIN_K && this.showOwners) this.drawBadges(pos, k, onScreen, shown);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
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
      this.stamp, sel, q, zoomBucket,
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

      const fam = famOf(e.relation);
      let width = 1.3, alpha = 0.5, dash: number[] = [];
      if (fam === "structure") { width = 2.4; alpha = 0.32; }
      else if (fam === "dependency") { width = 1.5; alpha = 0.55; }
      else if (fam === "contract") { alpha = 0.55; }
      else { dash = [2, 5]; width = 1.2; alpha = 0.28; }
      if (e.confidence === "inferred") dash = [5, 4];
      if (q) alpha = 0.12;
      if (role === "far") alpha = 0.06;

      const bucketKey = `${width}|${alpha}|${dash.join(",")}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = { path: new Path2D(), width, dash, color: this.theme.edge, alpha };
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
      const a = Math.round(alpha * 20) / 20; // quantised: keeps the bucket count tiny
      const key = `${n.type}|${a}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { path: new Path2D(), color: this.theme.node[n.type] ?? this.theme.edge, alpha: a, width: 0, dash: [] };
        buckets.set(key, bucket);
      }
      const r = Math.max(n.r, minR);
      bucket.path.moveTo(pos[i * 2] + r, pos[i * 2 + 1]);
      bucket.path.arc(pos[i * 2], pos[i * 2 + 1], r, 0, Math.PI * 2);
    }
    return [...buckets.values()];
  }

  /** The selected and hovered outlines — two circles, redrawn every frame because
   * hover changes far more often than the geometry does. */
  private paintRings(pos: Float32Array, sel: number, k: number): void {
    const ctx = this.ctx;
    const ring = (i: number, color: string, alpha: number, pad: number, width: number): void => {
      if (i < 0 || this.hiddenTypes[this.nodes[i].type]) return;
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = Math.max(width, width / k);
      ctx.beginPath();
      ctx.arc(pos[i * 2], pos[i * 2 + 1], this.nodes[i].r + pad, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (sel >= 0) ring(sel, this.theme.node[this.nodes[sel].type] ?? this.theme.edge, 0.55, 5, 1.6);
    if (this.hover >= 0 && this.hover !== sel) ring(this.hover, this.theme.ink, 0.35, 4, 1.2);
  }

  /** Focused edges: own colour, arrowhead, and the verb spelled out. */
  private paintFocus(pos: Float32Array, focused: { e: SimEdge; role: "out" | "in" }[], k: number): void {
    if (focused.length === 0) return;
    const ctx = this.ctx;
    for (const { e, role } of focused) {
      const color = role === "out" ? this.theme.out : this.theme.in;
      const path = new Path2D();
      this.edgePath(path, pos, e);
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = Math.max(2.2, MIN_EDGE_PX / k);
      if (e.confidence === "inferred") ctx.setLineDash([5 / k, 4 / k]);
      ctx.stroke(path);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      this.arrowHead(pos, e, 1.25);
    }
    if (k < LABEL_MIN_K) return;
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = this.theme.canvas;
    for (const { e, role } of focused) {
      const [sx, sy, tx, ty, ux, uy] = this.edgeEnds(pos, e);
      const lx = (sx + tx) / 2 - uy * 14;
      const ly = (sy + ty) / 2 + ux * 14;
      const text = e.relation.replace(/_/g, " ");
      ctx.strokeText(text, lx, ly);
      ctx.fillStyle = role === "out" ? this.theme.out : this.theme.in;
      ctx.fillText(text, lx, ly);
    }
  }

  /** Trimmed endpoints and the unit vector between them — the geometry every edge
   * drawing step needs, computed once. */
  private edgeEnds(pos: Float32Array, e: SimEdge): [number, number, number, number, number, number] {
    const ax = pos[e.s * 2], ay = pos[e.s * 2 + 1];
    const bx = pos[e.t * 2], by = pos[e.t * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / d, uy = dy / d;
    const ar = this.nodes[e.s].r, br = this.nodes[e.t].r;
    return [ax + ux * (ar + 2), ay + uy * (ar + 2), bx - ux * (br + 6), by - uy * (br + 6), ux, uy];
  }

  private edgePath(path: Path2D, pos: Float32Array, e: SimEdge): void {
    const [sx, sy, tx, ty, ux, uy] = this.edgeEnds(pos, e);
    // The same gentle bow the SVG had: two edges between the same pair stay
    // distinguishable, and a self-loop is not a zero-length line.
    const mx = (sx + tx) / 2 - uy * 10;
    const my = (sy + ty) / 2 + ux * 10;
    path.moveTo(sx, sy);
    path.quadraticCurveTo(mx, my, tx, ty);
  }

  private arrowHead(pos: Float32Array, e: SimEdge, scale: number): void {
    const ctx = this.ctx;
    const [sx, sy, tx, ty, ux, uy] = this.edgeEnds(pos, e);
    // Tangent at the curve's end, not the chord: the bow means they differ enough
    // for a chord-aligned head to sit visibly askew.
    const mx = (sx + tx) / 2 - uy * 10;
    const my = (sy + ty) / 2 + ux * 10;
    let dx = tx - mx, dy = ty - my;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= d; dy /= d;
    const size = 6 * scale;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - dx * size + dy * size * 0.5, ty - dy * size - dx * size * 0.5);
    ctx.lineTo(tx - dx * size - dy * size * 0.5, ty - dy * size + dx * size * 0.5);
    ctx.closePath();
    ctx.fill();
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
      if (i === sel || this.neighbors.has(i) || (q && n.name.toLowerCase().includes(q))) always.push(i);
      else if (k >= LABEL_MIN_K && !q && sel < 0) rest.push(i);
    }
    if (rest.length > MAX_LABELS) {
      rest.sort((a, b) => this.nodes[b].deg - this.nodes[a].deg);
      rest.length = MAX_LABELS;
    }
    const draw = always.length > MAX_LABELS ? always.slice(0, MAX_LABELS) : always.concat(rest);
    if (draw.length === 0) return;

    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = this.theme.canvas;
    ctx.fillStyle = this.theme.ink;
    for (const i of draw) {
      const n = this.nodes[i];
      const x = pos[i * 2];
      const y = pos[i * 2 + 1] + n.r + 15;
      ctx.strokeText(n.name, x, y);
      ctx.fillText(n.name, x, y);
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
