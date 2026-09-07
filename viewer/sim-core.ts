/**
 * The force layout, with no DOM in sight.
 *
 * Deliberately separate from both the renderer and the worker shell, because the
 * same code has to run in two places: inside a Worker when the page can spawn one,
 * and on the main thread when it cannot (a locked-down CSP, a `file://` export
 * opened in a browser that refuses blob workers). See `./sim.ts` for that choice.
 *
 * Positions cross the boundary as a flat `Float32Array` of `[x0,y0,x1,y1,…]`
 * rather than as objects: 26k nodes is 208KB that transfers in microseconds, where
 * structured-cloning 26k objects per frame would cost more than the layout itself.
 */
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY,
  type Simulation, type SimulationNodeDatum,
} from "d3-force";

/** A layout job, entirely in index space — no ids, no strings. */
export interface SimSpec {
  /** Node count. `radii` has this length, `positions` twice it. */
  count: number;
  /** Collision radius per node. */
  radii: Float32Array;
  /** Flat `[sourceIndex, targetIndex, …]` pairs. */
  links: Uint32Array;
  /** Spring rest length per link, one per pair in `links`. */
  distances: Float32Array;
  /** Seed positions, `[x0,y0,x1,y1,…]`. Reused positions keep a morph stable. */
  positions: Float32Array;
  width: number;
  height: number;
}

/**
 * Collision runs at every size.
 *
 * It was dropped above a few thousand nodes when the layout still ran on the main
 * thread, where its 88ms → 138ms a tick came straight out of the frame budget.
 * In a worker that cost buys nothing back: it makes the layout take longer in
 * wall-clock seconds and costs the UI nothing at all. And without it a large
 * graph piles nodes on top of each other, which is the one thing a reader
 * immediately reads as broken.
 */

interface Body extends SimulationNodeDatum {
  index: number;
  r: number;
}

export class Layout {
  private sim: Simulation<Body, undefined>;
  private bodies: Body[];

  constructor(spec: SimSpec) {
    this.bodies = new Array(spec.count);
    for (let i = 0; i < spec.count; i++) {
      this.bodies[i] = {
        index: i,
        r: spec.radii[i],
        x: spec.positions[i * 2],
        y: spec.positions[i * 2 + 1],
        vx: 0,
        vy: 0,
      };
    }
    const links = [];
    for (let i = 0, n = spec.links.length >> 1; i < n; i++) {
      links.push({
        source: this.bodies[spec.links[i * 2]],
        target: this.bodies[spec.links[i * 2 + 1]],
        distance: spec.distances[i],
      });
    }

    // `.stop()` first: the driver owns the clock. d3's own timer would tick on the
    // worker's rAF-less fallback interval, and on the main thread it would compete
    // with the render loop for exactly the frames we are trying to protect.
    this.sim = forceSimulation(this.bodies)
      .stop()
            // No `distanceMax`: capping it measured 7% faster and cost far more than that
      // in layout quality. Half of a wiring graph this size has no edges at all, and
      // long-range repulsion is the only force acting on those nodes — cut it and
      // they never leave the positions they were seeded at.
      // Repulsion scaled by radius. A fixed strength is tuned for same-sized dots
      // and leaves rolled-up module bubbles overlapping each other, which hides the
      // very bundles between them that the grouped view exists to show.
      .force("charge", forceManyBody<Body>().strength((b) => -220 - b.r * 16).theta(0.9))
      .force(
        "link",
        forceLink<Body, { source: Body; target: Body; distance: number }>(links)
          .distance((l) => l.distance)
          .strength(0.5),
      )
      .force("center", forceCenter<Body>(spec.width / 2, spec.height / 2))
      // Gravity, weak but essential. `forceCenter` only translates the system as a
      // whole; it exerts nothing on an individual node, so anything with no links
      // is pushed outward by charge and never pulled back. On a wiring graph —
      // where half the symbols have no edges, and whole modules can have no
      // cross-module reference — those escape to arbitrary distance, and a
      // "fit the graph" view then has to zoom out past the point of legibility to
      // frame a few strays. Two axis springs cost one multiply per node per tick.
      .force("gx", forceX<Body>(spec.width / 2).strength(0.02))
      .force("gy", forceY<Body>(spec.height / 2).strength(0.02));
    // Two passes rather than one: a single pass leaves visible overlap in the
    // dense core of a real wiring graph, which is exactly where people look.
    this.sim.force("collide", forceCollide<Body>().radius((b) => b.r + 14).iterations(2));
  }

  /** Advance the layout. `alpha` decays exactly as it would under d3's own timer. */
  tick(iterations = 1): void {
    this.sim.tick(iterations);
  }

  /** True while the layout is still moving enough to be worth redrawing. */
  get hot(): boolean {
    return this.sim.alpha() > this.sim.alphaMin();
  }

  /** Copy current positions into a caller-owned buffer. */
  read(into: Float32Array): void {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      into[i * 2] = bodies[i].x ?? 0;
      into[i * 2 + 1] = bodies[i].y ?? 0;
    }
  }

  reheat(alpha = 0.6): void {
    this.sim.alpha(alpha);
  }

  /** Pin a node under the pointer. `null` coordinates release it. */
  fix(index: number, x: number | null, y: number | null): void {
    const body = this.bodies[index];
    if (!body) return;
    body.fx = x;
    body.fy = y;
  }

  resize(width: number, height: number): void {
    this.sim.force("center", forceCenter<Body>(width / 2, height / 2));
  }

  stop(): void {
    this.sim.stop();
  }
}
