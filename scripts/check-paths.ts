// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Guard for the local raw archive (entscheidungen.md, Entscheidung 24.10.2026: Rohablage lokal bis M6).
// The raw archive in laufdaten/ holds unchanged EP responses with EP person identifiers; nothing of it
// may ever reach GitHub (build rule G1). The check fails if
//   - .gitignore does not list laufdaten/,
//   - any commit in the history (all refs) adds, changes or deletes a path below laufdaten/,
//   - any tracked file lies below laufdaten/ or is a graph database or raw file of the ingestion.
// CI runs it with the full history (fetch-depth 0). The same file runs in the data repository.
// Usage: node scripts/check-paths.ts [repo-dir]   (data repository: .github/scripts/check-paths.ts)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FORBIDDEN = [/(^|\/)laufdaten(\/|$)/, /(^|\/)graph\.sqlite(-wal|-shm)?$/, /(^|\/)raw\/(ep_api|cellar)\//];

export function forbiddenPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => FORBIDDEN.some((re) => re.test(p))))].sort();
}

export function gitignoreListsLaufdaten(text: string): boolean {
  return text.split(/\r?\n/).some((l) => /^\/?laufdaten\/?$/.test(l.trim()));
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function checkRepo(dir: string): string[] {
  const problems: string[] = [];
  let ignore = '';
  try {
    ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
  } catch {
    // missing file is reported below
  }
  if (!gitignoreListsLaufdaten(ignore)) problems.push('.gitignore does not list laufdaten/');
  if (git(dir, ['rev-parse', '--is-shallow-repository']).trim() === 'true') problems.push('shallow clone: history not checked (use fetch-depth 0)');
  const history = git(dir, ['log', '--all', '--name-only', '--format=']).split('\n').filter(Boolean);
  const tracked = git(dir, ['ls-files']).split('\n').filter(Boolean);
  for (const p of forbiddenPaths([...history, ...tracked])) problems.push(`forbidden path in Git: ${p}`);
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? '.';
  const problems = checkRepo(dir);
  for (const p of problems) console.error(`check-paths: ${p}`);
  console.log(`check-paths: ${problems.length} problem(s) in ${dir}`);
  if (problems.length) process.exit(1);
}
