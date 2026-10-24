// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// The local raw archive laufdaten/ must never reach a commit (entscheidungen.md, Entscheidung 24.10.2026).

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { checkRepo, forbiddenPaths, gitignoreListsLaufdaten } from '../scripts/check-paths.ts';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regesta-paths-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\nlaufdaten/\n');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('check-paths (laufdaten/ never in a commit)', () => {
  it('passes for this repository', () => {
    assert.deepEqual(checkRepo(fileURLToPath(new URL('..', import.meta.url))), []);
  });
  it('recognises the forbidden paths', () => {
    assert.deepEqual(forbiddenPaths(['src/a.ts', 'laufdaten/raw/ep_api/x.gz', 'x/laufdaten', 'graph.sqlite', 'raw/cellar/r/a.gz', 'docs/raw/notes.md']),
      ['graph.sqlite', 'laufdaten/raw/ep_api/x.gz', 'raw/cellar/r/a.gz', 'x/laufdaten']);
    assert.ok(gitignoreListsLaufdaten('node_modules/\nlaufdaten/\n'));
    assert.ok(!gitignoreListsLaufdaten('node_modules/\n'));
  });
  it('finds a file below laufdaten/ that was committed and deleted again', () => {
    const dir = repo();
    mkdirSync(join(dir, 'laufdaten'));
    writeFileSync(join(dir, 'laufdaten', 'raw.gz'), 'x');
    git(dir, 'add', '-f', 'laufdaten/raw.gz');
    git(dir, 'commit', '-q', '-m', 'oops');
    git(dir, 'rm', '-q', 'laufdaten/raw.gz');
    git(dir, 'commit', '-q', '-m', 'remove');
    assert.deepEqual(checkRepo(dir), ['forbidden path in Git: laufdaten/raw.gz']);
  });
  it('fails without laufdaten/ in .gitignore', () => {
    const dir = repo();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    assert.deepEqual(checkRepo(dir), ['.gitignore does not list laufdaten/']);
  });
});
