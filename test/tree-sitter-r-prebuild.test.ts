import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repairPrebuilds } from '../src/graph/tree-sitter-r-prebuild.js';
import { tmpRepo } from './helpers.js';

const SCOPED = '@davisvaughan+tree-sitter-r.node';
const EXPECTED = 'tree-sitter-r.node';

/** A prebuilds/ tree shaped like the one the grammar ships. */
function fixture(tag: string, platforms: string[]): string {
  const root = join(tmpRepo(tag), 'prebuilds');
  for (const platform of platforms) {
    mkdirSync(join(root, platform), { recursive: true });
    writeFileSync(join(root, platform, SCOPED), `binary for ${platform}`);
  }
  return root;
}

// The whole reason this moved out of the install script: under Bun the script
// never runs, so the grammar's binding would look for a file that isn't there.
test('repairPrebuilds gives every platform the name node-gyp-build looks for', () => {
  const root = fixture('ts-r-prebuild', ['linux-x64', 'darwin-arm64', 'win32-x64']);
  repairPrebuilds(root);
  for (const platform of ['linux-x64', 'darwin-arm64', 'win32-x64']) {
    const target = join(root, platform, EXPECTED);
    assert.ok(existsSync(target), `${platform} still missing ${EXPECTED}`);
    assert.equal(readFileSync(target, 'utf8'), `binary for ${platform}`);
  }
});

test('repairPrebuilds is idempotent — it runs on every import', () => {
  const root = fixture('ts-r-idempotent', ['linux-x64']);
  repairPrebuilds(root);
  repairPrebuilds(root);
  assert.equal(readFileSync(join(root, 'linux-x64', EXPECTED), 'utf8'), 'binary for linux-x64');
});

test('repairPrebuilds leaves an already-correct binary alone', () => {
  const root = fixture('ts-r-correct', ['linux-x64']);
  const target = join(root, 'linux-x64', EXPECTED);
  writeFileSync(target, 'the real one');
  repairPrebuilds(root);
  assert.equal(readFileSync(target, 'utf8'), 'the real one');
});

test('repairPrebuilds is a no-op when there is nothing to repair', () => {
  assert.doesNotThrow(() => repairPrebuilds(join(tmpRepo('ts-r-absent'), 'prebuilds')));
  const bare = join(tmpRepo('ts-r-bare'), 'prebuilds');
  mkdirSync(join(bare, 'linux-x64'), { recursive: true });
  repairPrebuilds(bare);
  assert.equal(existsSync(join(bare, 'linux-x64', EXPECTED)), false);
});
