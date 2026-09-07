/**
 * graft viz — viewer entry point. Wires tabs, chips, legend, search, theme,
 * SSE live reload, and the three views (Context graph / Code graph / Outline).
 */
import { loadContextGraph, loadCodeGraph, onServerChange, chipKey, CHIP_HINT, cvar, famOf, layerOf, type VizGraph, type Layer } from "./data.js";
import { shapeOf, shapeSvg } from "./palette.js";
import { GraphView } from "./graph.js";
import { renderDetail } from "./detail.js";
import { renderOutline } from "./tree.js";
import { groupGraph, availableDepths } from "./aggregate.js";
import { staticLayout, type LayoutMode } from "./layouts.js";
import { buildAdjacency, shortestPath, neighborhood, findCycles, hubs, type Adjacency } from "./analysis.js";

type Tab = "context" | "code" | "outline";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state = {
  tab: "context" as Tab,
  context: null as VizGraph | null,
  code: null as VizGraph | null,
  outlineOpen: {} as Record<string, boolean>,
};

/**
 * How the raw graph is turned into the one on screen.
 *
 * `depth` and `scope` are the aggregation: roll up to N directory levels, inside
 * an optional subtree. `shown` is the result, and everything downstream — chips,
 * legend, counts, every analysis — reads it rather than the raw graph, so what
 * you can ask about is always exactly what you can see.
 */
const tools = {
  depth: 0,
  scope: undefined as string | undefined,
  hideOrphans: false,
  layout: "force" as LayoutMode,
  /** Which kind of relation is on screen: what the code does, or how the tree is
   * assembled. See `setLayer`. */
  layer: "code" as Layer | "all",
  shown: null as VizGraph | null,
  adjacency: null as Adjacency | null,
  /** Set when `path` is waiting for its second endpoint. */
  pathFrom: null as string | null,
};

/** Past this, an ungrouped force layout is a dot cloud rather than a diagram, so
 * the first thing a reader sees is the rolled-up view. They can still turn it off. */
const AUTO_GROUP_NODES = 2000;
const LENS_HOPS = 2;

const view = new GraphView($("graphCanvas") as HTMLCanvasElement);

/** The dataset behind the current tab, before grouping. */
function rawGraph(): VizGraph | null {
  return state.tab === "context" ? state.context : state.code;
}

/** What is actually on the canvas — grouped, scoped, filtered. */
function activeGraph(): VizGraph | null {
  return tools.shown ?? rawGraph();
}

function graphTab(): "context" | "code" {
  return state.tab === "code" || state.tab === "outline" ? "code" : "context";
}

/* ---------- chips: verbs actually present, grouped only where obvious ---------- */
function renderChips(): void {
  const host = $("edgeChips");
  host.innerHTML = '<span class="cap">Edges</span>';
  const graph = activeGraph();
  if (!graph) return;
  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    const key = chipKey(e.relation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => {
    const rank = (k: string) => (k === "part of" ? 0 : k === "uses" ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const key of keys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "echip" + (view.hiddenRels[key] ? "" : " on");
    btn.innerHTML = `${glyphFor(key)} ${key} <span style="opacity:.55">${counts.get(key)}</span>`;
    btn.title = (CHIP_HINT[key] ?? `"${key}" edges`) + " — click to " + (view.hiddenRels[key] ? "show" : "hide");
    btn.addEventListener("click", () => {
      view.hiddenRels[key] = !view.hiddenRels[key];
      renderChips();
      view.restyle();
      updateShownCount();
    });
    host.appendChild(btn);
  }
}

function glyphFor(key: string): string {
  const fam = key === "part of" ? "structure" : key === "uses" ? "dependency" : famOf(key.replace(/ /g, "_"));
  const glyphs: Record<string, string> = {
    structure: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" stroke-width="3" opacity=".5"/></svg>',
    dependency: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="14" y2="4" stroke="currentColor" stroke-width="1.6"/><path d="M14,1 L19,4 L14,7 z" fill="currentColor"/></svg>',
    contract: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="13" y2="4" stroke="currentColor" stroke-width="1.4"/><path d="M13,1 L19,4 L13,7 z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    association: '<svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 4" opacity=".7"/></svg>',
  };
  return glyphs[fam];
}

/* ---------- node-type legend ---------- */
function renderLegend(): void {
  const host = $("legend");
  host.innerHTML = "";
  const graph = activeGraph();
  if (!graph) return;
  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  // Shape, not colour. Colour is spent on which module a node belongs to — the
  // question that actually organises the picture — so kind is carried by outline
  // and the legend has to show the outline rather than a swatch.
  const ink = cvar("--ink");
  for (const [type, count] of counts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lchip" + (view.hiddenTypes[type] ? " off" : "");
    chip.innerHTML = `${shapeSvg(shapeOf(type), ink)}${type} <span style="color:var(--muted);font-weight:500">${count}</span>`;
    chip.addEventListener("click", () => {
      view.hiddenTypes[type] = !view.hiddenTypes[type];
      renderLegend();
      view.restyle();
      updateShownCount();
    });
    host.appendChild(chip);
  }

  // A decoration toggle, not a type filter: it sits after the type chips, carries
  // its own class, and deliberately does NOT feed `updateShownCount` — hiding a
  // face hides no node.
  const hint = document.createElement("span");
  hint.className = "lhint";
  hint.textContent = tools.depth > 0 ? "colour = module" : "colour = directory";
  host.appendChild(hint);

  const graphHasOwners = graph.nodes.some((n) => n.owners?.length);
  if (graphHasOwners) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lchip lchip-people" + (view.showOwners ? "" : " off");
    chip.innerHTML = `<span class="sw" style="background:${cvar("--con")}"></span>people`;
    chip.title = "Show who has worked on each area";
    chip.addEventListener("click", () => {
      view.showOwners = !view.showOwners;
      renderLegend();
      view.restyle();
    });
    host.appendChild(chip);
  }
}

function updateShownCount(): void {
  const graph = activeGraph();
  if (!graph) { $("lcount").textContent = ""; return; }
  const shown = graph.nodes.filter((n) => !view.hiddenTypes[n.type]).length;
  $("lcount").textContent = `${shown} / ${graph.nodes.length} nodes shown`;
}

function updateCounts(): void {
  const el = $("counts");
  if (state.tab === "outline" && state.code) {
    const files = state.code.nodes.filter((n) => n.type === "file").length;
    el.textContent = `${files} files · ${state.code.nodes.length} symbols`;
  } else {
    const graph = activeGraph();
    const raw = rawGraph();
    if (!graph) { el.textContent = ""; return; }
    const unit = tools.depth > 0 ? "groups" : "nodes";
    const link = tools.depth > 0 ? "bundles" : "links";
    // Say what was rolled away, so a smaller number never reads as a smaller repo.
    const of = raw && raw.nodes.length !== graph.nodes.length ? ` of ${raw.nodes.length} symbols` : "";
    el.textContent = `${graph.nodes.length} ${unit} · ${graph.edges.length} ${link}${of}`;
  }
}

/* ---------- detail panel ---------- */
function showDetail(id: string | null): void {
  renderDetail($("detail"), state.tab === "context" ? state.context : state.code, graphTab(), id, (next) => {
    if (state.tab === "outline") {
      showDetail(next);
      renderOutline($("tree"), state.code!, next, state.outlineOpen, showDetail);
    } else {
      view.focus(next);
    }
  });
}

view.onSelect = (id) => { if (!maybeCompletePath(id)) showDetail(id); };

/**
 * What actually makes two things relate.
 *
 * A bundle between two modules used to say only "these are connected", which is
 * the least useful half of the fact — the reader's next question is always
 * *which* call, so they know the one line to open or the one dependency to break.
 * The grouping keeps the real symbol pairs on the bundle; this renders them,
 * resolved back to names through the ungrouped graph, and clicking one jumps to
 * that symbol.
 */
view.onSelectEdge = (edge) => {
  const host = $("detail");
  if (!edge) { showDetail(view.selected); return; }
  const shown = activeGraph();
  const raw = rawGraph();
  const nameIn = (g: VizGraph | null, id: string): string =>
    g?.nodes.find((n) => n.id === id)?.name ?? id.split("#").pop() ?? id;
  const endpoint = (id: string): string => escapeText(nameIn(shown, id));
  const verb = escapeText(edge.relation.replace(/_/g, " "));

  const rows = (edge.members ?? []).map((m) => {
    const path = raw?.nodes.find((n) => n.id === m.source)?.path ?? "";
    return `<li><button class="linkbtn" data-goto="${escapeText(m.source)}">${escapeText(nameIn(raw, m.source))}</button>`
      + ` <span class="verb">${verb}</span> `
      + `<button class="linkbtn" data-goto="${escapeText(m.target)}">${escapeText(nameIn(raw, m.target))}</button>`
      + (path ? `<div class="where">${escapeText(path)}</div>` : "")
      + `</li>`;
  });

  host.innerHTML =
    `<div class="edgehead"><b>${endpoint(edge.source)}</b> <span class="verb">${verb}</span> <b>${endpoint(edge.target)}</b></div>`
    + (edge.weight && edge.weight > 1 ? `<div class="edgesub">${edge.weight} references</div>` : "")
    + (rows.length
      ? `<ul class="edgelist">${rows.join("")}</ul>`
        + (edge.moreMembers ? `<div class="edgesub">and ${edge.moreMembers} more</div>` : "")
      : `<div class="edgesub">A single reference.</div>`);

  for (const b of host.querySelectorAll<HTMLButtonElement>("[data-goto]")) {
    b.addEventListener("click", () => {
      const id = b.dataset.goto!;
      // The symbol lives in the ungrouped graph; drop the grouping to reach it.
      if (!shown?.nodes.some((n) => n.id === id)) { tools.depth = 0; applyTools(); }
      view.focus(id);
    });
  }
};

/* ---------- tabs ---------- */
function setTab(tab: Tab): void {
  state.tab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
  });
  // Drop the previous tab's derived graph before anything reads it: `activeGraph`
  // answers from it, and a stale one would have the code tab measuring, grouping
  // and drawing the context tab's nodes.
  tools.shown = null;
  tools.adjacency = null;
  const isOutline = tab === "outline";
  $("canvasWrap").hidden = isOutline;
  $("outlineView").hidden = !isOutline;
  view.hiddenRels = {};
  view.hiddenTypes = {};
  view.selected = null;
  showDetail(null);

  const empty = $("graphEmpty");
  if (tab === "outline") {
    if (state.code) renderOutline($("tree"), state.code, null, state.outlineOpen, showDetail);
    else {
      $("outlineView").hidden = true;
      $("canvasWrap").hidden = false;
      showEmpty("No code graph yet — run <code>graft graph</code> to generate <span class=\"mono\">graph.json</span>.");
    }
  } else {
    const graph = rawGraph();
    if (!graph || graph.nodes.length === 0) {
      // A graph that exists but holds no nodes used to fall through to the canvas
      // and render nothing at all — worst on an exported page, where the reader
      // arrived from a link that promised a diagram.
      // The note names changed FILES, and a path on a fork's branch is written by
      // whoever opened the pull request — it reaches a published page, so it is
      // escaped rather than trusted.
      showEmpty(graph?.meta.emptyNote ? escapeText(graph.meta.emptyNote) : (tab === "code"
        ? "No code graph yet — run <code>graft graph</code> to generate <span class=\"mono\">graph.json</span>."
        : "No context graph — run <code>graft init</code> first."));
    } else {
      empty.hidden = true;
      // A fresh tab starts un-drilled, and large graphs start grouped.
      tools.scope = undefined;
      tools.pathFrom = null;
      view.spotlight = null;
      const big = graph.nodes.length > AUTO_GROUP_NODES;
      tools.depth = big ? Math.min(2, availableDepths(graph).length) : 0;
      tools.hideOrphans = big;
      applyTools();
    }
  }
  renderChips();
  renderLegend();
  updateShownCount();
  updateCounts();
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function showEmpty(html: string): void {
  const empty = $("graphEmpty");
  empty.innerHTML = html;
  empty.hidden = false;
}

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
  b.addEventListener("click", () => setTab(b.dataset.tab as Tab));
});

/* ---------- search ---------- */
const search = $("search") as HTMLInputElement;
search.addEventListener("input", () => {
  view.query = search.value.trim();
  view.restyle();
});
search.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && view.query) {
    const hit = view.firstMatch();
    if (hit) view.focus(hit.id);
  }
});

/* ---------- zoom controls ---------- */
$("zin").addEventListener("click", () => view.zoomBy(1.25));
$("zout").addEventListener("click", () => view.zoomBy(1 / 1.25));
$("zreset").addEventListener("click", () => view.resetView());

/* ---------- theme ---------- */
const THEME_KEY = "graft-viz-theme";
const savedTheme = localStorage.getItem(THEME_KEY);
if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
$("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = current ? current === "dark" : systemDark;
  const next = isDark ? "light" : "dark";
  root.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  view.restyle();
  renderChips();
  renderLegend();
  showDetail(view.selected);
});

/* ---------- resizable detail panel ---------- */
const DETAIL_W_KEY = "graft-viz-detail-w";
const MIN_DETAIL = 220;
const rootEl = document.documentElement;
const clampDetail = (px: number): number =>
  Math.min(Math.max(MIN_DETAIL, Math.round(window.innerWidth * 0.6)), Math.max(MIN_DETAIL, Math.round(px)));
function setDetailWidth(px: number, persist = true): void {
  const w = clampDetail(px);
  rootEl.style.setProperty("--detail-w", `${w}px`);
  if (persist) localStorage.setItem(DETAIL_W_KEY, String(w));
}
const savedDetailW = Number(localStorage.getItem(DETAIL_W_KEY));
if (Number.isFinite(savedDetailW) && savedDetailW >= MIN_DETAIL) setDetailWidth(savedDetailW, false);

const resizer = $("detailResizer");
let draggingDetail = false;
resizer.addEventListener("pointerdown", (ev) => {
  const pe = ev as PointerEvent;
  draggingDetail = true;
  resizer.setPointerCapture(pe.pointerId);
  document.body.style.cursor = "col-resize";
  ev.preventDefault();
});
resizer.addEventListener("pointermove", (ev) => {
  if (!draggingDetail) return;
  // panel is flush to the window's right edge: width = distance from cursor to that edge.
  setDetailWidth(window.innerWidth - (ev as PointerEvent).clientX);
});
const endDetailDrag = (ev: Event): void => {
  if (!draggingDetail) return;
  draggingDetail = false;
  document.body.style.cursor = "";
  try { resizer.releasePointerCapture((ev as PointerEvent).pointerId); } catch { /* not captured */ }
  view.reheat();
};
resizer.addEventListener("pointerup", endDetailDrag);
resizer.addEventListener("pointercancel", endDetailDrag);
resizer.addEventListener("keydown", (ev) => {
  const ke = ev as KeyboardEvent;
  if (ke.key !== "ArrowLeft" && ke.key !== "ArrowRight") return;
  const step = ke.shiftKey ? 40 : 16;
  const cur = $("detail").getBoundingClientRect().width;
  setDetailWidth(cur + (ke.key === "ArrowLeft" ? step : -step));
  view.reheat();
  ev.preventDefault();
});


/* ---------- grouping, layout, and the analysis tools ---------- */

/**
 * Recompute what is on the canvas from `tools`, then hand it to the renderer.
 *
 * The single funnel: every control below changes `tools` and calls this, so there
 * is exactly one place where "what the reader asked for" becomes "what is drawn",
 * and no way for a chip, a legend and a finding to disagree about which graph
 * they are describing.
 */
function applyTools(): void {
  const raw = rawGraph();
  if (!raw) return;
  const shown = groupGraph(raw, { depth: tools.depth, scope: tools.scope, hideOrphans: tools.hideOrphans });
  tools.shown = shown;
  tools.adjacency = buildAdjacency(shown);
  // A finding names ids from the previous view; keep only the ones that survived.
  if (view.spotlight) {
    const alive = new Set(shown.nodes.map((n) => n.id));
    const kept = new Set([...view.spotlight].filter((id) => alive.has(id)));
    view.spotlight = kept.size ? kept : null;
  }

  view.setData(shown, graphTab());
  const positions = staticLayout(tools.layout, shown, tools.depth || 2);
  if (positions) view.useStaticPositions(positions);
  else view.reheat();
  view.resetView();

  renderGroupOptions(raw);
  renderCrumbs();
  setLayer(tools.layer);
  renderChips();
  renderLegend();
  updateShownCount();
  updateCounts();
  $("orphanChip").className = "echip" + (tools.hideOrphans ? "" : " on");
  $("clearBtn").hidden = view.spotlight === null;
}

/** Depth options are the levels this repo actually has, not a fixed list. */
function renderGroupOptions(raw: VizGraph): void {
  const sel = $("groupSel") as HTMLSelectElement;
  const depths = availableDepths(raw);
  const wanted = String(tools.depth);
  const options = ["0", ...depths.map(String)];
  if (sel.dataset.built !== options.join(",")) {
    sel.innerHTML = "";
    for (const d of options) {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = d === "0" ? "symbols" : d === "1" ? "top level" : `${d} levels`;
      sel.appendChild(o);
    }
    sel.dataset.built = options.join(",");
  }
  sel.value = options.includes(wanted) ? wanted : "0";
}

/** Where in the tree we have drilled to, and the way back out. */
function renderCrumbs(): void {
  const host = $("crumbs");
  host.innerHTML = "";
  if (!tools.scope) { host.hidden = true; return; }
  host.hidden = false;
  const parts = tools.scope.split("/");
  const add = (label: string, target: string | undefined): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => { tools.scope = target; applyTools(); });
    host.appendChild(b);
  };
  add("all", undefined);
  parts.forEach((part, i) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    host.appendChild(sep);
    add(part, parts.slice(0, i + 1).join("/"));
  });
}

/** One line saying what was found, or nothing at all. */
function showFinding(html: string | null): void {
  const el = $("finding");
  if (!html) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = html;
  el.hidden = false;
}

function setSpotlight(ids: Set<string> | null, message: string | null): void {
  view.spotlight = ids;
  view.restyle();
  showFinding(message);
  $("clearBtn").hidden = ids === null;
}

// Clicking a bubble means "go in there": scope to that directory and re-group one
// level deeper, which is the same gesture as opening a folder.
view.onDrill = (prefix) => {
  tools.scope = prefix;
  tools.depth = prefix.split("/").length + 1;
  applyTools();
};

($("groupSel") as HTMLSelectElement).addEventListener("change", (ev) => {
  tools.depth = Number((ev.target as HTMLSelectElement).value);
  applyTools();
});
($("layoutSel") as HTMLSelectElement).addEventListener("change", (ev) => {
  tools.layout = (ev.target as HTMLSelectElement).value as LayoutMode;
  applyTools();
});
$("orphanChip").addEventListener("click", () => {
  tools.hideOrphans = !tools.hideOrphans;
  applyTools();
});

/**
 * Code edges and file edges answer different questions, so you look at one at a
 * time.
 *
 * `imports` — a TypeScript import, a Rust `use`, a C `#include` — relates two
 * FILES. `calls` relates two SYMBOLS. Folded together, 13,591 call edges sat
 * under a wall of include lines and neither could be read. Nothing here is
 * language-specific: it keys on the relation graft already emits.
 */
function setLayer(layer: Layer | "all"): void {
  const graph = activeGraph();
  if (!graph) return;
  tools.layer = layer;
  view.hiddenRels = {};
  if (layer !== "all") {
    for (const e of graph.edges) {
      if (layerOf(e.relation) !== layer) view.hiddenRels[chipKey(e.relation)] = true;
    }
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-layer]")) {
    b.className = "echip" + (b.dataset.layer === layer ? " on" : "");
  }
  renderChips();
  view.restyle();
  updateShownCount();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-layer]")) {
  b.addEventListener("click", () => setLayer(b.dataset.layer as Layer | "all"));
}

$("cyclesBtn").addEventListener("click", () => {
  if (!tools.adjacency) return;
  const cycles = findCycles(tools.adjacency);
  if (cycles.length === 0) { setSpotlight(null, "No dependency cycles in this view."); return; }
  const ids = new Set(cycles.flat());
  const biggest = cycles[0].length;
  setSpotlight(ids, `<b>${cycles.length}</b> dependency ${cycles.length === 1 ? "cycle" : "cycles"}, largest <b>${biggest}</b> nodes.`);
});

$("hubsBtn").addEventListener("click", () => {
  if (!tools.adjacency) return;
  const top = hubs(tools.adjacency, 20);
  if (top.length === 0) { setSpotlight(null, "Nothing in this view is connected."); return; }
  setSpotlight(
    new Set(top.map((h) => h.id)),
    `Top <b>${top.length}</b> by connections — highest: <b>${escapeText(nameOf(top[0].id))}</b> (${top[0].degree}).`,
  );
});

$("lensBtn").addEventListener("click", () => {
  if (!tools.adjacency || !view.selected) { showFinding("Select a node first, then press lens."); return; }
  const ids = neighborhood(tools.adjacency, view.selected, LENS_HOPS);
  setSpotlight(ids, `<b>${ids.size}</b> within ${LENS_HOPS} hops of <b>${escapeText(nameOf(view.selected))}</b>.`);
});

// Two clicks, because a path needs two ends: the first press remembers the
// selection, the next selection completes it.
$("pathBtn").addEventListener("click", () => {
  if (!view.selected) { showFinding("Select one end of the path, then press path."); return; }
  tools.pathFrom = view.selected;
  showFinding(`From <b>${escapeText(nameOf(view.selected))}</b> — now select the other end.`);
});

$("clearBtn").addEventListener("click", () => {
  tools.pathFrom = null;
  setSpotlight(null, null);
});

function nameOf(id: string): string {
  return activeGraph()?.nodes.find((n) => n.id === id)?.name ?? id;
}

/** Completing a pending path, when a second node is chosen. */
function maybeCompletePath(id: string | null): boolean {
  if (!tools.pathFrom || !id || !tools.adjacency || id === tools.pathFrom) return false;
  const from = tools.pathFrom;
  tools.pathFrom = null;
  const path = shortestPath(tools.adjacency, from, id);
  if (path.length === 0) {
    setSpotlight(null, `No path from <b>${escapeText(nameOf(from))}</b> to <b>${escapeText(nameOf(id))}</b> — nothing depends that way round.`);
    return true;
  }
  setSpotlight(
    new Set(path),
    `<b>${path.length - 1}</b> ${path.length === 2 ? "hop" : "hops"}: ${path.map((p) => escapeText(nameOf(p))).join(" → ")}`,
  );
  return true;
}

/* ---------- data loading + live reload ---------- */
async function loadAll(): Promise<void> {
  const [context, code] = await Promise.all([loadContextGraph(), loadCodeGraph()]);
  state.context = context;
  state.code = code;
  // The subtitle only exists on an exported page (`graft viz --export --title`),
  // where the same file is published per pull request and the reader needs to know
  // WHICH one they opened.
  const where = [context.meta.repoName, context.meta.subtitle].filter(Boolean).join(" · ");
  $("repoName").textContent = where;
  document.title = `graft viz — ${where}`;
  // A blast export ships one tab: its Code tab would be the repo's whole wiring
  // graph, which answers nothing about the pull request the page is about.
  const tabs = context.meta.tabs;
  if (tabs) {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
      b.hidden = !tabs.includes(b.dataset.tab as Tab);
    });
  }
  // An exported page says which tab holds its content: a structural build has no
  // concept nodes, so the default Context tab would open on an empty canvas.
  const wanted = context.meta.defaultTab;
  setTab(wanted && wanted !== state.tab ? wanted : state.tab);
}

onServerChange(() => {
  const selected = view.selected;
  void loadAll().then(() => {
    if (selected) { view.selected = selected; view.restyle(); showDetail(selected); }
  });
});

void loadAll();
