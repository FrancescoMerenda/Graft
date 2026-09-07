/**
 * Repairs `@davisvaughan/tree-sitter-r`'s mis-named prebuilt binary, at load time.
 *
 * prebuildify names the artifact after the *scoped* package, so the grammar ships
 * `prebuilds/<platform>-<arch>/@davisvaughan+tree-sitter-r.node` while its own
 * `bindings/node/index.js` (through node-gyp-build) looks for `tree-sitter-r.node`.
 * The package's `install` script papers over that — when it is allowed to run.
 * Under Bun it never is. We depend on the grammar through an alias
 * (`"tree-sitter-r": "npm:@davisvaughan/tree-sitter-r"`), and Bun matches
 * `trustedDependencies` against neither the alias nor the real name, so the script
 * stays blocked however that list is written. A global `bun add -g @nanonets/graft`
 * makes it worse still: lifecycle trust is read from the *root* project, which
 * there is Bun's own global package.json — one we do not own and cannot amend.
 *
 * So the repair cannot live in a lifecycle script at all. It runs in-process,
 * before the grammar resolves its binding.
 *
 * Import this module for its side effect *above* the `tree-sitter-r` import — ES
 * modules evaluate in declaration order, and that ordering is what makes the fix
 * land in time.
 */
import { copyFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SCOPED_BINARY = "@davisvaughan+tree-sitter-r.node";
const EXPECTED_BINARY = "tree-sitter-r.node";

/** The grammar's `prebuilds/` dir, resolved through the module graph rather than
 * guessed from `__dirname` — the package sits wherever the installer hoisted it
 * (repo `node_modules/`, a global root, an npx/bunx cache). */
function prebuildsDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return join(dirname(req.resolve("tree-sitter-r/package.json")), "prebuilds");
  } catch {
    return null; // grammar not installed — the import below reports it far better than we could
  }
}

/** Symlinks (or, where symlinks are denied, copies) each scoped prebuild under
 * `root` to the name node-gyp-build expects. Idempotent, and silent on failure:
 * a read-only install has nothing we can do, and the `tree-sitter-r` import that
 * follows raises the real error.
 *
 * Takes the directory rather than finding it so a test can point it at a fixture. */
export function repairPrebuilds(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const platformDir = join(root, entry.name);
    const scoped = join(platformDir, SCOPED_BINARY);
    const expected = join(platformDir, EXPECTED_BINARY);
    if (!existsSync(scoped) || existsSync(expected)) continue;
    try {
      symlinkSync(SCOPED_BINARY, expected);
    } catch {
      try {
        copyFileSync(scoped, expected);
      } catch {
        /* read-only install; nothing left to try */
      }
    }
  }
}

/** Locates the installed grammar and repairs it. A no-op when the grammar is
 * missing — the import that follows this module reports that far better. */
export function fixTreeSitterRPrebuilds(): void {
  const root = prebuildsDir();
  if (root) repairPrebuilds(root);
}

fixTreeSitterRPrebuilds();
