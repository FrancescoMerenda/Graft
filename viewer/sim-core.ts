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
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide,
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
 * Above this, collision is dropped.
 *
 * Measured on a 26k-node graph: charge+link+center is 88ms a tick and adding
 * collide takes it to 138ms — a 56% tax for separation that is invisible at a
 * density where the nodes are already further apart than their own radii. Below
 * the threshold the graph is sparse enough for overlap to actually show, and the
 * force is cheap enough not to matter.
 */
const COLLIDE_MAX_NODES = 4000;

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
      .force("charge", forceManyBody<Body>().strength(-220).theta(0.9))
      .force(
        "link",
        forceLink<Body, { source: Body; target: Body; distance: number }>(links)
          .distance((l) => l.distance)
          .strength(0.5),
      )
      .force("center", forceCenter<Body>(spec.width / 2, spec.height / 2));
    if (spec.count <= COLLIDE_MAX_NODES) {
      this.sim.force("collide", forceCollide<Body>().radius((b) => b.r + 6));
    }
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
