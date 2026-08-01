import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { shouldSkipDir, walkDir, SKIP_DIRS } from "../src/ingest/fs.js";
import { discoverScopes, discoverWorkspaceChildren } from "../src/graph/scopes.js";

function fixture(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `graft-walk-${tag}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function write(root: string, path: string, content = "export const value = 1;\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function walked(root: string): string[] {
  return walkDir(root)
    .map((path) => relative(root, path).replace(/\\/g, "/"))
    .sort();
}

test("walkDir respects root and nested .gitignore rules, including negation", () => {
  const dir = fixture("ignore");
  try {
    write(dir, ".gitignore", "Scripts/bundles/\ngenerated/*\n!generated/keep.ts\n");
    write(dir, "src/app.ts");
    write(dir, "Scripts/bundles/app.js");
    write(dir, "generated/drop.ts");
    write(dir, "generated/keep.ts");
    write(dir, "packages/tool/.gitignore", "output/\n");
    write(dir, "packages/tool/index.ts");
    write(dir, "packages/tool/output/bundle.js");

    assert.deepEqual(walked(dir), [
      "generated/keep.ts",
      "packages/tool/index.ts",
      "src/app.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkDir keeps tracked files that match an ignore rule and untracked visible files", () => {
  const dir = fixture("tracked");
  try {
    write(dir, ".gitignore", "*.generated.ts\n");
    write(dir, "tracked.generated.ts");
    write(dir, "ignored.generated.ts");
    write(dir, "visible.ts");
    execFileSync("git", ["add", "-f", "tracked.generated.ts"], { cwd: dir });

    assert.deepEqual(walked(dir), ["tracked.generated.ts", "visible.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkDir retains fixed skips and filesystem fallback outside Git", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-walk-nongit-"));
  try {
    write(dir, "src/app.ts");
    write(dir, "node_modules/pkg/index.ts");
    write(dir, ".hidden/secret.ts");

    assert.deepEqual(walked(dir), ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A4 — shouldSkipDir consolidation.
 *
 * "Is this name dot-prefixed or in SKIP_DIRS" is re-implemented by hand in
 * three places: `skippedPath`'s per-segment predicate and `walkFilesystem`'s
 * directory check (both src/ingest/fs.ts), and `discoverWorkspaceChildren`'s
 * git-child filter (src/graph/scopes.ts). `shouldSkipDir` is the single
 * source of truth now; these tests pin the predicate's contract and prove
 * every consumer — the file walk, marker-scope discovery and workspace-glob
 * resolution (both derived from the walked file set), and git-child
 * discovery — agrees on exactly the same skip set.
 */

test("shouldSkipDir: every SKIP_DIRS name and any dot-prefixed name is skipped; an ordinary name is not", () => {
  for (const name of SKIP_DIRS) assert.equal(shouldSkipDir(name), true, `${name} should be skipped`);
  assert.equal(shouldSkipDir(".git"), true);
  assert.equal(shouldSkipDir(".github"), true);
  assert.equal(shouldSkipDir("."), true);
  assert.equal(shouldSkipDir("src"), false);
  assert.equal(shouldSkipDir("app"), false);
});

/** One subdirectory per SKIP_DIRS name, plus a dot-directory and a normal
 * directory — each holding a package.json marker, a source file, and a
 * nested .git, so every check under test (file walk, marker-scope discovery,
 * workspace-glob resolution, git-child discovery) has something to find IF
 * it fails to skip. Deliberately not a git repo, so walkDir exercises the
 * filesystem fallback where the built-in skip list is the only guard. */
function buildSkipFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-skipdirs-"));
  const seed = (relDir: string, sourceName: string) => {
    const sub = join(dir, relDir);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "package.json"), "{}");
    writeFileSync(join(sub, sourceName), "export const X = 1;\n");
    mkdirSync(join(sub, ".git"));
  };
  for (const name of SKIP_DIRS) seed(name, "junk.ts");
  seed(".hidden", "junk.ts");
  seed("app", "real.ts");
  return dir;
}

test("walkDir and every scopes.ts consumer agree on the skip set: SKIP_DIRS + a dot-dir are all skipped, a normal dir survives", () => {
  const dir = buildSkipFixture();
  try {
    // walkDir (fs.ts)
    const files = walkDir(dir);
    const rels = files.map((f) => f.slice(dir.length + 1));
    assert.ok(rels.includes(join("app", "real.ts")), "walkDir must still find the normal dir's file");
    for (const name of SKIP_DIRS) {
      assert.ok(!rels.some((r) => r.startsWith(`${name}${"/"}`) || r.startsWith(join(name, ""))), `walkDir must skip ${name}/`);
    }
    assert.ok(!rels.some((r) => r.startsWith(".hidden")), "walkDir must skip the dot-dir");

    // discoverScopes (scopes.ts) — its candidate dirs derive from the walked
    // file set, so a skipped dir's package.json must never surface as a scope.
    const scopes = discoverScopes(dir);
    const prefixes = scopes.map((s) => s.prefix);
    assert.ok(prefixes.includes("app"), "discoverScopes must still find the normal dir's marker");
    for (const name of SKIP_DIRS) assert.ok(!prefixes.includes(name), `discoverScopes must not surface ${name} as a scope`);
    assert.ok(!prefixes.includes(".hidden"), "discoverScopes must not surface the dot-dir as a scope");

    // discoverWorkspaceChildren (scopes.ts)
    const children = discoverWorkspaceChildren(dir);
    assert.ok(children.includes("app"), "discoverWorkspaceChildren must still find the normal git child");
    for (const name of SKIP_DIRS) assert.ok(!children.includes(name), `discoverWorkspaceChildren must skip ${name}`);
    assert.ok(!children.includes(".hidden"), "discoverWorkspaceChildren must skip the dot-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace-glob resolution (scopes.ts's resolveGlob over visible-file dirs) also honors the skip set", () => {
  const dir = buildSkipFixture();
  try {
    // A `packages: ['*']` intent resolves every immediate subdir as a workspace
    // match UNLESS it's absent from the visible-file dir set — if that set
    // stopped agreeing with shouldSkipDir, a SKIP_DIRS name or the dot-dir
    // would show up here as its own scope (workspace matches become candidates
    // even without a marker).
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - '*'\n");
    const scopes = discoverScopes(dir);
    const prefixes = scopes.map((s) => s.prefix);
    assert.ok(prefixes.includes("app"), "the normal dir must still resolve as a workspace match");
    for (const name of SKIP_DIRS) assert.ok(!prefixes.includes(name), `the glob must not resolve into ${name}`);
    assert.ok(!prefixes.includes(".hidden"), "the glob must not resolve into the dot-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
