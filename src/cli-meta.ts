/**
 * `graft version` / `graft --version` / `graft upgrade` support.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath } from "./util/paths.js";

const PKG_NAME = "@nanonets/graft";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** True when the running module lives under an npx cache dir (e.g.
 * `~/.npm/_npx/<hash>/node_modules/...`) rather than a regular global install.
 *
 * Normalized first: `fileURLToPath` returns the *platform* separator, so on
 * Windows the cache path is `…\_npx\…` and a bare `includes("/_npx/")` is always
 * false — `graft upgrade` would then run `npm install -g` on top of an npx run.
 * Same hardcoded-`/` mistake as #33; `src/util/paths.ts` exists for exactly this. */
export function isRunningViaNpx(moduleUrl: string): boolean {
  return toPosixPath(fileURLToPath(moduleUrl)).includes("/_npx/");
}

/** Which package manager owns the install this module is running from. */
export type InstallManager = "npm" | "bun";

/** Bun's install root — `$BUN_INSTALL`, else `~/.bun`. */
function bunInstallRoot(): string {
  return process.env.BUN_INSTALL || join(homedir(), ".bun");
}

/** Distinguishes a Bun-owned install from an npm-owned one by where the module
 * sits on disk: Bun puts globals in `<BUN_INSTALL>/install/global/node_modules`
 * and unpacks `bunx` runs into `<BUN_INSTALL>/install/cache`, neither of which an
 * npm layout produces. Nothing is spawned — `graft upgrade` must not pay for a
 * subprocess just to learn which upgrade command to print.
 *
 * Normalized to posix for the same reason {@link isRunningViaNpx} is: on Windows
 * `fileURLToPath` returns backslashes, and a hardcoded `/` probe never matches. */
export function detectInstallManager(moduleUrl: string): InstallManager {
  const path = toPosixPath(fileURLToPath(moduleUrl));
  const bunRoot = toPosixPath(bunInstallRoot());
  if (path.startsWith(`${bunRoot}/`)) return "bun";
  return path.includes("/install/global/node_modules/") || path.includes("/install/cache/") ? "bun" : "npm";
}

/** The manager owning *this* install, resolved from this module's own location.
 * `cli-meta.js` ships inside the package, so its path witnesses the install just
 * as well as the CLI entry's does — and callers deep in the tree (hooks, the
 * statusline) get the right answer without threading a module URL down. */
export const INSTALL_MANAGER: InstallManager = detectInstallManager(import.meta.url);

/** True when this run came from a throwaway `bunx` unpack rather than a real
 * install — the Bun counterpart of {@link isRunningViaNpx}, and the same no-op:
 * `bunx` already fetches the latest on every run, so there is nothing to upgrade. */
export function isRunningViaBunx(moduleUrl: string): boolean {
  return toPosixPath(fileURLToPath(moduleUrl)).includes("/install/cache/");
}

/** True when the run is a one-off fetch (npx or bunx) with no install to replace. */
export function isRunningEphemerally(moduleUrl: string): boolean {
  return isRunningViaNpx(moduleUrl) || isRunningViaBunx(moduleUrl);
}

/** The command that installs graft globally under a given manager, for both
 * running and printing — the two must never drift apart. */
export function globalInstallCommand(manager: InstallManager, spec: string = PKG_NAME): string[] {
  return manager === "bun" ? ["bun", "add", "-g", spec] : ["npm", "install", "-g", spec];
}

export interface NpmViewResult {
  ok: boolean;
  version?: string;
}

/** One registry lookup attempt, offline-safe. */
function viewVersion(bin: string, args: string[], timeoutMs: number): NpmViewResult {
  try {
    const res = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === "win32", // npm/bun are .cmd shims there
    });
    if (res.error || res.signal || res.status !== 0) return { ok: false };
    const version = res.stdout?.trim();
    if (!version) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

/** Latest published version, offline-safe: any failure (no package manager, no
 * network, timeout) resolves to `{ ok: false }` rather than throwing.
 *
 * Tries `npm view` first, then `bun info` — a Bun-only machine may have no npm
 * at all, and without the fallback every version check there reads as "offline". */
export function getNpmViewVersion(pkgName: string = PKG_NAME, timeoutMs = 2000): NpmViewResult {
  const viaNpm = viewVersion("npm", ["view", pkgName, "version"], timeoutMs);
  if (viaNpm.ok) return viaNpm;
  return viewVersion("bun", ["info", pkgName, "version"], timeoutMs);
}

/** Pure formatter for `graft version` — no I/O, easy to unit-test. */
export function formatVersionReport(current: string, latest: NpmViewResult): string {
  const lines = [`graft ${current}`];
  if (!latest.ok || !latest.version) {
    lines.push("latest: unreachable (offline?)");
  } else if (latest.version === current) {
    lines.push(`latest on npm: ${current} ✓ up to date`);
  } else {
    lines.push(`latest on npm: ${latest.version} — run graft upgrade`);
  }
  return lines.join("\n");
}

/** The global node_modules dir for a manager. npm's is asked for (it moves with
 * Homebrew/Windows/volta layouts); Bun's is fixed under its install root, so it
 * costs no subprocess. */
function globalRoot(manager: InstallManager): string | null {
  if (manager === "bun") {
    const root = join(bunInstallRoot(), "install", "global", "node_modules");
    return existsSync(root) ? root : null;
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Reads the version actually sitting in the global install, straight from
 * disk — more reliable right after a global install than re-querying the
 * registry (which just tells you what "latest" is, not what landed locally). */
export function readGlobalInstalledVersion(
  pkgName: string = PKG_NAME,
  manager: InstallManager = "npm",
): string | null {
  const root = globalRoot(manager);
  if (!root) return null;
  const pkgJson = join(root, ...pkgName.split("/"), "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface UpgradeResult {
  /** True when the global install actually ran (false for the npx/bunx no-op path). */
  ran: boolean;
  ok: boolean;
  /** Present when ran=true and the install failed. */
  errorMessage?: string;
  oldVersion?: string;
  newVersion?: string;
  /** Which manager owns this install; decides the command shown and run. */
  manager?: InstallManager;
}

/** Pure formatter for a finished upgrade — no I/O, easy to unit-test. */
export function formatUpgradeReport(result: UpgradeResult): string {
  const manager = result.manager ?? "npm";
  const runner = manager === "bun" ? "bunx" : "npx";
  const install = globalInstallCommand(manager).join(" ");
  if (!result.ran) {
    return (
      `running via ${runner} — ${runner} already fetches the latest graft on every run.\n` +
      `For a permanent install: ${install}`
    );
  }
  if (!result.ok) {
    return `✗ ${globalInstallCommand(manager, `${PKG_NAME}@latest`).join(" ")} failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
  }
  return `graft ${result.oldVersion ?? "?"} → ${result.newVersion ?? result.oldVersion ?? "?"}`;
}

/** Globally installs the latest graft with whichever manager owns this install
 * (inheriting stdio so the user sees that manager's own progress/errors), then
 * re-reads the freshly installed version. No-ops with guidance under npx/bunx.
 *
 * Upgrading a Bun-installed graft with npm was the bug this replaces: npm would
 * write into its own global root, leaving the `bun` install — the one actually on
 * PATH — untouched, so `graft upgrade` reported success and changed nothing. */
export function runUpgrade(moduleUrl: string): UpgradeResult {
  const oldVersion = readCurrentVersion(moduleUrl);
  const manager = detectInstallManager(moduleUrl);
  if (isRunningEphemerally(moduleUrl)) {
    return { ran: false, ok: true, oldVersion, manager };
  }
  const [bin, ...args] = globalInstallCommand(manager, `${PKG_NAME}@latest`);
  const res = spawnSync(bin, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (res.error || (res.status ?? 1) !== 0) {
    return { ran: true, ok: false, oldVersion, manager, errorMessage: res.error?.message };
  }
  const newVersion =
    readGlobalInstalledVersion(PKG_NAME, manager) ?? getNpmViewVersion(PKG_NAME).version ?? oldVersion;
  return { ran: true, ok: true, oldVersion, newVersion, manager };
}
