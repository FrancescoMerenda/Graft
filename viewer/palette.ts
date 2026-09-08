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
export type Shape = "circle" | "square" | "diamond" | "triangle" | "hexagon" | "pentagon" | "octagon";

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
  // Its own outline, not a second pentagon: two kinds that can appear side by side
  // must not share a shape, or the channel stops carrying anything for either.
  enum: "octagon",
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
 * How much a shape must grow to cover the same area as a circle of radius 1.
 *
 * Inscribing every shape in the node radius made them all the same WIDTH, which
 * is not the same as the same SIZE: a triangle inscribed in a circle covers 41%
 * of it, so a triangular node read as less important than a round one carrying
 * identical weight. Area is what the eye compares, so area is what is held equal.
 *
 * A regular n-gon inscribed in radius r has area (n/2)·r²·sin(2π/n); the factor
 * below is √(π / that), the radius multiplier that restores the circle's area.
 */
const AREA_FIT: Record<Shape, number> = {
  circle: 1,
  triangle: 1.5551,
  square: 1.2533,
  diamond: 1.2533,
  pentagon: 1.1487,
  hexagon: 1.0996,
  octagon: 1.0545,
};

/**
 * The widest line of text a shape can hold across its middle, as a multiple of
 * the node radius.
 *
 * Not derived from the shape's width: a diamond is full width at exactly one
 * height and pinches to nothing above and below it, so text sized to its widest
 * chord spills straight out of the corners. These are the widths that hold a
 * line with its ascenders and descenders inside the outline.
 */
const TEXT_FIT: Record<Shape, number> = {
  circle: 1.55,
  triangle: 0.95,
  square: 1.30,
  diamond: 1.05,
  pentagon: 1.35,
  hexagon: 1.45,
  octagon: 1.50,
};

function sidesOf(shape: Shape): number {
  return shape === "triangle" ? 3
    : shape === "diamond" ? 4
      : shape === "pentagon" ? 5
        : shape === "octagon" ? 8 : 6;
}

/** The radius to draw `shape` at so it covers the same area as a circle of `r`. */
export function sizedFor(shape: Shape, r: number): number {
  return r * AREA_FIT[shape];
}

/** Width available for a label inside `shape`, at node radius `r`. */
export function textWidthIn(shape: Shape, r: number): number {
  return r * TEXT_FIT[shape];
}

/**
 * Append one shape of radius `r` at `(x, y)` to a path.
 *
 * Sized so its AREA matches a circle of radius `r`, not so it fits inside one.
 * Regular polygons start at -90°, putting a point at the top where the eye
 * expects one.
 */
export function shapePath(path: Path2D, shape: Shape, x: number, y: number, radius: number): void {
  const r = sizedFor(shape, radius);
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
  const sides = sidesOf(shape);
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
  // The legend glyph is bounded by its chip, so it fits to the box rather than
  // growing for area the way a node does.
  const r = (c - 0.5) / AREA_FIT[shape] * (shape === "circle" ? 1 : 1.18);
  if (shape === "circle") {
    return `<svg width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}"/></svg>`;
  }
  if (shape === "square") {
    const h = r * Math.SQRT1_2;
    return `<svg width="${size}" height="${size}" aria-hidden="true"><rect x="${c - h}" y="${c - h}" width="${h * 2}" height="${h * 2}" fill="${color}"/></svg>`;
  }
  const sides = sidesOf(shape);
  const rotation = shape === "diamond" ? 0 : -Math.PI / 2;
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push(`${(c + Math.cos(a) * r).toFixed(2)},${(c + Math.sin(a) * r).toFixed(2)}`);
  }
  return `<svg width="${size}" height="${size}" aria-hidden="true"><polygon points="${pts.join(" ")}" fill="${color}"/></svg>`;
}
