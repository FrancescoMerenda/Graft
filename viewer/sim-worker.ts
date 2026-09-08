/**
 * Worker shell around {@link Layout}: runs the force layout off the main thread so
 * pan, zoom, hover and selection stay at 60fps while a 26k-node graph is still
 * settling (the layout itself costs ~90ms a tick at that size — eight frames).
 *
 * Bundled separately and inlined into the app bundle as a string, so an exported
 * single-file page still gets a worker. See scripts/build-viewer.mjs.
 *
 * Backpressure, not buffering: the worker owns two position buffers and posts one
 * only when the renderer has handed the previous one back. A renderer that falls
 * behind therefore drops position updates instead of growing a queue of them — the
 * layout never waits for the screen, and the screen never renders a stale backlog.
 */
import { Layout, type SimSpec } from "./sim-core.js";

export type ToWorker =
  | { type: "data"; spec: SimSpec }
  | { type: "reheat"; alpha?: number }
  | { type: "fix"; index: number; x: number | null; y: number | null }
  | { type: "resize"; width: number; height: number }
  | { type: "return"; buffer: ArrayBuffer }
  | { type: "stop" };

export type FromWorker = { type: "positions"; buffer: ArrayBuffer; hot: boolean };

/** Ticks per batch. One tick per message would spend more time in postMessage than
 * in the layout; a whole batch between posts keeps the ratio the other way up. */
const TICKS_PER_BATCH = 2;

const scope = self as unknown as {
  postMessage(message: FromWorker, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

let layout: Layout | null = null;
let free: Float32Array[] = [];
let running = false;

function pump(): void {
  if (!layout || running) return;
  running = true;
  const step = (): void => {
    if (!layout) { running = false; return; }
    layout.tick(TICKS_PER_BATCH);
    const buffer = free.pop();
    if (buffer) {
      layout.read(buffer);
      scope.postMessage({ type: "positions", buffer: buffer.buffer as ArrayBuffer, hot: layout.hot }, [buffer.buffer as ArrayBuffer]);
    }
    if (layout.hot) {
      setTimeout(step, 0);
    } else {
      running = false;
      // One last frame at rest, so the renderer always ends on the settled layout
      // even if the buffer it would have used was in flight on the final tick.
      const last = free.pop();
      if (last) {
        layout.read(last);
        scope.postMessage({ type: "positions", buffer: last.buffer as ArrayBuffer, hot: false }, [last.buffer as ArrayBuffer]);
      }
    }
  };
  step();
}

scope.onmessage = (event: MessageEvent<ToWorker>): void => {
  const msg = event.data;
  switch (msg.type) {
    case "data":
      layout?.stop();
      layout = new Layout(msg.spec);
      free = [new Float32Array(msg.spec.count * 2), new Float32Array(msg.spec.count * 2)];
      pump();
      break;
    case "reheat":
      layout?.reheat(msg.alpha);
      pump();
      break;
    case "fix":
      layout?.fix(msg.index, msg.x, msg.y);
      break;
    case "resize":
      layout?.resize(msg.width, msg.height);
      break;
    case "return":
      free.push(new Float32Array(msg.buffer));
      break;
    case "stop":
      layout?.stop();
      layout = null;
      free = [];
      break;
  }
};
