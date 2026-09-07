import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve, sep } from 'node:path';
import {
  formatVersionReport,
  formatUpgradeReport,
  resolvePackageJsonPath,
  readCurrentVersion,
  isRunningViaNpx,
  isRunningViaBunx,
  detectInstallManager,
  globalInstallCommand,
} from '../src/cli-meta.js';

// --- formatVersionReport: pure formatting, injected npm-view results (no network) ---

test('formatVersionReport: up to date', () => {
  const out = formatVersionReport('0.4.4', { ok: true, version: '0.4.4' });
  assert.equal(out, 'graft 0.4.4\nlatest on npm: 0.4.4 ✓ up to date');
});

test('formatVersionReport: newer version available', () => {
  const out = formatVersionReport('0.4.4', { ok: true, version: '0.4.5' });
  assert.equal(out, 'graft 0.4.4\nlatest on npm: 0.4.5 — run graft upgrade');
});

test('formatVersionReport: offline / unreachable', () => {
  const out = formatVersionReport('0.4.4', { ok: false });
  assert.equal(out, 'graft 0.4.4\nlatest: unreachable (offline?)');
});

// --- formatUpgradeReport: pure formatting, injected upgrade results (no network, no spawn) ---

test('formatUpgradeReport: npx no-op suggests a permanent install', () => {
  const out = formatUpgradeReport({ ran: false, ok: true, oldVersion: '0.4.4' });
  assert.match(out, /npx/);
  assert.match(out, /npm install -g @nanonets\/graft/);
});

test('formatUpgradeReport: bunx no-op suggests the bun install, not the npm one', () => {
  const out = formatUpgradeReport({ ran: false, ok: true, oldVersion: '0.4.4', manager: 'bun' });
  assert.match(out, /bunx/);
  assert.match(out, /bun add -g @nanonets\/graft/);
  assert.doesNotMatch(out, /npm/);
});

test('formatUpgradeReport: a failed bun install names the bun command', () => {
  const out = formatUpgradeReport({ ran: true, ok: false, oldVersion: '0.4.4', manager: 'bun', errorMessage: 'ENOENT' });
  assert.match(out, /bun add -g @nanonets\/graft@latest failed/);
});

test('formatUpgradeReport: successful upgrade shows old -> new', () => {
  const out = formatUpgradeReport({ ran: true, ok: true, oldVersion: '0.4.4', newVersion: '0.4.5' });
  assert.equal(out, 'graft 0.4.4 → 0.4.5');
});

test('formatUpgradeReport: failed install surfaces the error', () => {
  const out = formatUpgradeReport({ ran: true, ok: false, oldVersion: '0.4.4', errorMessage: 'ENOENT' });
  assert.match(out, /failed/);
  assert.match(out, /ENOENT/);
});

// --- resolvePackageJsonPath / readCurrentVersion: real filesystem, no network ---

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  const found = resolvePackageJsonPath(fakeDistCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  const found = resolvePackageJsonPath(fakeSrcCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});

// --- isRunningViaNpx: pure path heuristic ---
//
// Built with `join` rather than a `/`-separated literal so the path carries the
// platform separator: `fileURLToPath` hands back `…\_npx\…` on Windows, where the
// original `includes("/_npx/")` was always false and `graft upgrade` would have run
// `npm install -g` on top of an npx invocation. On posix this is the identity case.

test('isRunningViaNpx detects an npx cache path', () => {
  const npxPath = pathToFileURL(
    join(sep, 'Users', 'x', '.npm', '_npx', 'abc123', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(npxPath), true);
});

test('isRunningViaNpx is false for a regular global install', () => {
  const globalPath = pathToFileURL(
    join(sep, 'usr', 'local', 'lib', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(isRunningViaNpx(globalPath), false);
});

// --- detectInstallManager / isRunningViaBunx: pure path heuristics ---
//
// Same `join(sep, …)` construction as above, for the same Windows reason: these
// probe a normalized posix form of a platform path.

test('detectInstallManager: bun global install', () => {
  const bunGlobal = pathToFileURL(
    join(sep, 'home', 'x', '.bun', 'install', 'global', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(detectInstallManager(bunGlobal), 'bun');
});

test('detectInstallManager: bunx cache is bun-owned and ephemeral', () => {
  const bunxCache = pathToFileURL(
    join(sep, 'home', 'x', '.bun', 'install', 'cache', '@nanonets', 'graft@0.17.0', 'dist', 'cli.js'),
  ).href;
  assert.equal(detectInstallManager(bunxCache), 'bun');
  assert.equal(isRunningViaBunx(bunxCache), true);
});

test('detectInstallManager: npm global and npx caches stay npm', () => {
  const npmGlobal = pathToFileURL(
    join(sep, 'usr', 'local', 'lib', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  const npxCache = pathToFileURL(
    join(sep, 'home', 'x', '.npm', '_npx', 'abc123', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js'),
  ).href;
  assert.equal(detectInstallManager(npmGlobal), 'npm');
  assert.equal(detectInstallManager(npxCache), 'npm');
  assert.equal(isRunningViaBunx(npmGlobal), false);
});

test('detectInstallManager honours a relocated BUN_INSTALL', () => {
  const root = join(sep, 'opt', 'bun');
  const relocated = pathToFileURL(join(root, 'install', 'global', 'node_modules', '@nanonets', 'graft', 'dist', 'cli.js')).href;
  const before = process.env.BUN_INSTALL;
  process.env.BUN_INSTALL = root;
  try {
    assert.equal(detectInstallManager(relocated), 'bun');
  } finally {
    if (before === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = before;
  }
});

// --- globalInstallCommand: the single source both the runner and the printer use ---

test('globalInstallCommand: one command per manager', () => {
  assert.deepEqual(globalInstallCommand('npm'), ['npm', 'install', '-g', '@nanonets/graft']);
  assert.deepEqual(globalInstallCommand('bun', '@nanonets/graft@latest'), ['bun', 'add', '-g', '@nanonets/graft@latest']);
});
