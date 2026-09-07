/**
 * Owns the layout and hides where it runs.
 *
 * A Worker is the whole point — the layout costs ~90ms a tick on a 26k-node graph,
 * which on the main thread caps the entire UI at 11fps while it settles. But a
 * worker is not always available (a strict CSP, a `file://` export in a browser
 * that will not take a blob URL), and the viewer must still work there, just
 * slower. Both paths present the same surface, so nothing above this file knows
 * which one it got.
 *
 * `positions` is a stable array the renderer may read at any time. Buffers coming
 * back from the worker are copied into it and returned immediately: the copy is
 * ~20µs for 26k nodes, and it buys a contract with no ownership rules at all.
 */
import { Layout, type SimSpec } from "./sim-core.js";
import type { FromWorker, ToWorker } from "./sim-worker.js";

/** The worker's own bundle, inlined at build time (see scripts/build-viewer.mjs).
 * Absent when the viewer runs unbundled, which is exactly when the inline layout
 * path is the right answer anyway. */
declare const __GRAFT_SIM_WORKER__: string | undefined;

function workerSource(): string | null {
  try {
    return typeof __GRAFT_SIM_WORKER__ === "string" ? __GRAFT_SIM_WORKER__ : null;
  } catch {
    return null; // not defined at all in an unbundled dev load
  }
}

/** Layout milliseconds the inline path is allowed to spend per frame. Past this it
 * yields to the renderer: a slow layout is survivable, a frozen page is not. */
const INLINE_BUDGET_MS = 8;

export class LayoutDriver {
  /** Live positions, `[x0,y0,x1,y1,…]`, index-aligned with the node array. */
  positions = new Float32Array(0);
  /** True while the layout is still moving. */
  hot = false;
  /** Called after every position update the renderer should draw. */
  onFrame: () => void = () => {};

  private worker: Worker | null = null;
  private inline: Layout | null = null;
  private inlineTimer = 0;
  private count = 0;

  constructor() {
    const source = workerSource();
    if (!source) return;
    try {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      this.worker = new Worker(url, { type: "classic" });
      URL.revokeObjectURL(url);
      this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
      // A worker that dies mid-layout must not take the graph with it: drop to the
      // inline path and carry on from wherever the positions had reached.
      this.worker.onerror = () => this.demote();
    } catch {
      this.worker = null; // blob workers refused — inline it is
    }
  }

  private receive(msg: FromWorker): void {
    const incoming = new Float32Array(msg.buffer);
    if (incoming.length === this.positions.length) this.positions.set(incoming);
    this.hot = msg.hot;
    this.post({ type: "return", buffer: msg.buffer }, [msg.buffer]);
    this.onFrame();
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  /** Fall back to the main thread, keeping whatever layout we already have. */
  private demote(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  setData(spec: SimSpec): void {
    this.count = spec.count;
    this.positions = new Float32Array(spec.positions);
    this.stopInline();
    if (this.worker) {
      this.post({ type: "data", spec });
      return;
    }
    this.inline = new Layout(spec);
    this.runInline();
  }

  /**
   * The inline layout, time-sliced. Ticks until the frame budget is spent, paints,
   * then yields — so even without a worker the page keeps responding, at the cost
   * of a layout that settles over more wall-clock seconds.
   */
  private runInline(): void {
    if (!this.inline) return;
    const step = (): void => {
      if (!this.inline) return;
      const until = performance.now() + INLINE_BUDGET_MS;
      do {
        this.inline.tick(1);
      } while (this.inline.hot && performance.now() < until);
      this.inline.read(this.positions);
      this.hot = this.inline.hot;
      this.onFrame();
      if (this.hot) this.inlineTimer = requestAnimationFrame(step);
    };
    this.inlineTimer = requestAnimationFrame(step);
  }

  private stopInline(): void {
    cancelAnimationFrame(this.inlineTimer);
    this.inline?.stop();
    this.inline = null;
  }

  reheat(alpha = 0.6): void {
    if (this.worker) { this.post({ type: "reheat", alpha }); return; }
    this.inline?.reheat(alpha);
    if (this.inline && !this.hot) { this.hot = true; this.runInline(); }
  }

  fix(index: number, x: number | null, y: number | null): void {
    if (this.worker) { this.post({ type: "fix", index, x, y }); return; }
    this.inline?.fix(index, x, y);
  }

  resize(width: number, height: number): void {
    if (this.worker) { this.post({ type: "resize", width, height }); return; }
    this.inline?.resize(width, height);
  }

  stop(): void {
    this.post({ type: "stop" });
    this.stopInline();
    this.hot = false;
  }

  get size(): number {
    return this.count;
  }
}
