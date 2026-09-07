/**
 * Colour means "which module", shape means "what kind of thing".
 *
 * The two questions a reader asks of a node are independent, so they get
 * independent channels. Encoding kind as colour — as this did — spends the
 * strongest visual channel there is on a seven-way distinction nobody scans for,
 * and leaves the one that actually organises the picture (which directory is
 * this?) with no encoding at all. So sixty-six modules in sixty-six colours,
 * and kind carried by outline instead.
 *
 * Hues come from the golden angle rather than an even split, so any number of
 * groups is distinguishable and adding a group does not recolour the rest.
 * Lightness and saturation are fixed per theme, which keeps every colour at
 * roughly equal weight — no module looks more important than another because it
 * happened to land on yellow.
 */

/** Golden angle in degrees: successive hues never repeat or cluster. */
const HUE_STEP = 137.508;

/** A starting hue that puts the first, biggest module in a calm blue-green
 * rather than a shouting red. */
const HUE_ORIGIN = 172;

/** Kept off the extremes on both themes: fully saturated colour vibrates against
 * a dark ground, and washed-out colour is indistinguishable on a light one. */
const DARK = { s: 58, l: 62 };
const LIGHT = { s: 62, l: 45 };

/**
 * A stable colour per key, assigned in the order given.
 *
 * Order matters and is the caller's business: passing groups largest-first means
 * the biggest modules get the most separated hues, which is where separation is
 * worth the most.
 */
export function groupPalette(keys: string[], dark: boolean): Map<string, string> {
  const { s, l } = dark ? DARK : LIGHT;
  const out = new Map<string, string>();
  keys.forEach((key, i) => {
    out.set(key, `hsl(${(HUE_ORIGIN + i * HUE_STEP) % 360} ${s}% ${l}%)`);
  });
  return out;
}

/** The shapes a node kind can take. */
export type Shape = "circle" | "square" | "diamond" | "triangle" | "hexagon" | "pentagon";

/**
 * Kind → outline.
 *
 * Chosen so the distinctions that matter most are the easiest to tell apart at a
 * glance: a round thing runs (function, method), a cornered thing holds state
 * (class, file), and a many-sided thing is a contract or a name (interface,
 * type, enum). Anything unmapped is a circle, which is also what a rolled-up
 * module is — a bubble is not a kind of symbol.
 */
const SHAPES: Record<string, Shape> = {
  function: "circle",
  method: "triangle",
  class: "square",
  file: "diamond",
  interface: "hexagon",
  type: "pentagon",
  enum: "pentagon",
  group: "circle",
  // The context tab's own kinds.
  system: "hexagon",
  concept: "circle",
  api: "pentagon",
  changed: "square",
  affected: "diamond",
};

export function shapeOf(kind: string): Shape {
  return SHAPES[kind] ?? "circle";
}

/**
 * Append one shape of radius `r` at `(x, y)` to a path.
 *
 * Every shape is inscribed in the same circle, so a square does not read as
 * bigger than a circle of the same node size. Regular polygons start at -90°,
 * putting a point at the top where the eye expects one.
 */
export function shapePath(path: Path2D, shape: Shape, x: number, y: number, r: number): void {
  if (shape === "circle") {
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  if (shape === "square") {
    // Inscribed, so its diagonal — not its side — matches the circle's diameter.
    const h = r * Math.SQRT1_2;
    path.rect(x - h, y - h, h * 2, h * 2);
    return;
  }
  const sides = shape === "diamond" ? 4 : shape === "triangle" ? 3 : shape === "pentagon" ? 5 : 6;
  const rotation = shape === "diamond" ? 0 : -Math.PI / 2;
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
}

/** The same shape as inline SVG, for a legend chip. */
export function shapeSvg(shape: Shape, color: string, size = 11): string {
  const c = size / 2;
  const r = c - 0.5;
  if (shape === "circle") {
    return `<svg width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}"/></svg>`;
  }
  if (shape === "square") {
    const h = r * Math.SQRT1_2;
    return `<svg width="${size}" height="${size}" aria-hidden="true"><rect x="${c - h}" y="${c - h}" width="${h * 2}" height="${h * 2}" fill="${color}"/></svg>`;
  }
  const sides = shape === "diamond" ? 4 : shape === "triangle" ? 3 : shape === "pentagon" ? 5 : 6;
  const rotation = shape === "diamond" ? 0 : -Math.PI / 2;
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push(`${(c + Math.cos(a) * r).toFixed(2)},${(c + Math.sin(a) * r).toFixed(2)}`);
  }
  return `<svg width="${size}" height="${size}" aria-hidden="true"><polygon points="${pts.join(" ")}" fill="${color}"/></svg>`;
}
