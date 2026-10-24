// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Ingestion run from the command line (M1: Q1 EP API, Q2 Cellar).
// The data directory holds the graph (SQLite), the raw archive and the run reports. Raw EP responses
// contain EP person identifiers (roles in the procedure), so the directory must lie outside every Git
// repository: nothing of it may reach GitHub (build rule G1).
//
// Usage:
//   node scripts/ingest.ts --data-dir <dir> --procedures 2025/0102(COD),2021/0106(COD)
//   node scripts/ingest.ts --data-dir <dir> --frame COD:1972-2026        (scope from the events; first run)
//   node scripts/ingest.ts --data-dir <dir> --scope COD                  (daily run: in scope + lists of this and last year)
//   add --simulate-outage ep_api[,cellar] to let a source fail (HTTP 503) for criterion K4

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { HttpRequest, HttpResponse, SourceId, Transport } from '../src/ingest/http.ts';
import { fetchTransport } from '../src/ingest/http.ts';
import { runIngestion, type RunOptions } from '../src/ingest/run.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function insideGitRepo(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

export const outage = (status = 503): Transport => async (_req: HttpRequest): Promise<HttpResponse> =>
  ({ status, headers: { 'content-type': 'text/plain' }, body: Buffer.from('simulated outage') });

async function main(): Promise<void> {
  const dataDir = arg('data-dir');
  if (!dataDir) throw new Error('--data-dir is required');
  const repo = insideGitRepo(dataDir);
  if (repo) throw new Error(`--data-dir ${dataDir} lies inside the Git repository ${repo}; raw EP data must never be committed (G1)`);

  let select: RunOptions['select'];
  const procs = arg('procedures');
  const frame = arg('frame');
  const scope = arg('scope');
  if (procs) select = { mode: 'explicit', procedures: procs.split(',').map((s) => s.trim()).filter(Boolean) };
  else if (frame) {
    const [types, years] = frame.split(':');
    const [from, to] = years.split('-').map(Number);
    select = { mode: 'frame', types: types.split(','), years: Array.from({ length: to - from + 1 }, (_, i) => from + i) };
  } else if (scope) select = { mode: 'scope', types: scope.split(',') };
  else throw new Error('one of --procedures, --frame, --scope is required');

  const transports: Partial<Record<SourceId, Transport>> = {};
  for (const s of (arg('simulate-outage') ?? '').split(',').filter(Boolean)) transports[s as SourceId] = outage();

  const summary = await runIngestion({
    dataDir,
    select,
    transports: { ep_api: transports.ep_api ?? fetchTransport, cellar: transports.cellar ?? fetchTransport },
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });

  const reports = join(dataDir, 'reports');
  mkdirSync(reports, { recursive: true });
  const base = join(reports, summary.run.replace(/:/g, ''));
  const { fetchLog, ...rest } = summary;
  writeFileSync(`${base}.json`, JSON.stringify({ ...rest, simulatedOutage: Object.keys(transports) }, null, 2));
  const header = 'source,attempt,not_before,started,finished,status,retry_after_s,error,url';
  const esc = (v: unknown) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(`${base}-fetch-log.csv`, [header, ...fetchLog.map((e) => [e.source, e.attempt, e.not_before, e.started, e.finished, e.status, e.retry_after_s, e.error, e.url].map(esc).join(','))].join('\n') + '\n');
  console.log(JSON.stringify({ ...rest, licence: rest.licence.map((l) => ({ source: l.source, url: l.url })) }, null, 2));
  console.log(`report: ${base}.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
