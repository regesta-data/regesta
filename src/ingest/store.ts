// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Graph store for M1 (SQLite, 05-architektur.md 4) and the raw archive (05-architektur.md 2.3).
// M1 keeps the current state per procedure and source; the statements with valid_from/valid_to
// follow in M3. Rule for M1 (03-datenmodell.md 5, criterion K4): rows of a procedure are only
// written after a successful fetch of that source for that procedure. A failed source leaves every
// row of the procedure untouched and is recorded only in the source health.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import type { FetchLogEntry, SourceId } from './http.ts';

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, started TEXT NOT NULL, finished TEXT, status TEXT NOT NULL, scope TEXT NOT NULL, checksum TEXT
);
CREATE TABLE IF NOT EXISTS source_health (
  run TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, requests INTEGER NOT NULL, errors TEXT NOT NULL,
  median_ms INTEGER, p95_ms INTEGER, objects INTEGER NOT NULL, objects_failed INTEGER NOT NULL, last_success TEXT, note TEXT,
  PRIMARY KEY (run, source)
);
CREATE TABLE IF NOT EXISTS fetch_log (
  run TEXT NOT NULL, seq INTEGER NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL, attempt INTEGER NOT NULL,
  not_before TEXT, started TEXT NOT NULL, finished TEXT NOT NULL, status INTEGER, retry_after_s INTEGER, error TEXT,
  started_ms INTEGER NOT NULL, finished_ms INTEGER NOT NULL, retry_after_ms INTEGER, not_before_ms INTEGER, response_excerpt TEXT,
  PRIMARY KEY (run, seq)
);
CREATE TABLE IF NOT EXISTS run_items (
  run TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT,
  PRIMARY KEY (run, source, key)
);
CREATE TABLE IF NOT EXISTS raw_objects (
  run TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, retrieved TEXT NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, path TEXT NOT NULL, same_as_run TEXT,
  PRIMARY KEY (run, source, key)
);
CREATE TABLE IF NOT EXISTS licence_evidence (
  run TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL, retrieved TEXT NOT NULL, wording TEXT NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY (run, source, url)
);
CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT, ep_stage TEXT, ep_committees TEXT,
  cellar_file_status TEXT, in_scope INTEGER NOT NULL DEFAULT 0, latest_ep_event TEXT,
  first_seen_run TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS object_state (
  procedure TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL, changed_run TEXT NOT NULL, checked_run TEXT NOT NULL,
  PRIMARY KEY (procedure, source)
);
CREATE TABLE IF NOT EXISTS identifiers (
  procedure TEXT NOT NULL, alias_type TEXT NOT NULL, alias TEXT NOT NULL, source TEXT NOT NULL,
  provenance TEXT NOT NULL, sources TEXT NOT NULL, license TEXT NOT NULL,
  PRIMARY KEY (procedure, alias_type, alias, source)
);
CREATE INDEX IF NOT EXISTS identifiers_alias ON identifiers (alias_type, alias);
CREATE TABLE IF NOT EXISTS steps (
  procedure TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, institution TEXT NOT NULL, kind TEXT NOT NULL,
  source_kind TEXT, date TEXT, date_precision TEXT, refs TEXT NOT NULL, provenance TEXT NOT NULL, sources TEXT NOT NULL, license TEXT NOT NULL,
  PRIMARY KEY (procedure, id, source)
);
CREATE TABLE IF NOT EXISTS documents (
  procedure TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, institution TEXT NOT NULL, doc_type TEXT NOT NULL,
  date TEXT, url TEXT, access TEXT NOT NULL, provenance TEXT NOT NULL, sources TEXT NOT NULL, license TEXT NOT NULL,
  PRIMARY KEY (procedure, id, source)
);
CREATE TABLE IF NOT EXISTS edges (
  procedure TEXT NOT NULL, edge TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, source TEXT NOT NULL,
  provenance TEXT NOT NULL, sources TEXT NOT NULL, license TEXT NOT NULL,
  PRIMARY KEY (procedure, edge, from_id, to_id, source)
);
CREATE TABLE IF NOT EXISTS legal_acts (
  procedure TEXT NOT NULL, celex TEXT NOT NULL, eli TEXT, oj_ref TEXT, dates TEXT NOT NULL, source TEXT NOT NULL,
  sources TEXT NOT NULL, license TEXT NOT NULL,
  PRIMARY KEY (procedure, celex, source)
);
CREATE TABLE IF NOT EXISTS gaps (
  procedure TEXT NOT NULL, institution TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, since TEXT, source TEXT NOT NULL,
  PRIMARY KEY (procedure, institution, kind, source)
);
`;

export interface SourceRef {
  source: SourceId;
  url: string;
  ref?: string;
  retrieved: string;
  license: string;
  legal_basis: string;
}
export type Provenance =
  | { status: 'official' }
  | { status: 'derived'; rule: string; rule_version: string; quality: 'exact' | 'high' | 'medium'; evidence: string[] }
  | { status: 'missing'; reason: string };

export interface IdentifierRow { alias_type: string; alias: string; provenance: Provenance; sources: SourceRef[]; license: string }
export interface StepRow {
  id: string; institution: 'commission' | 'parliament' | 'council'; kind: string; source_kind?: string; date: string | null;
  date_precision: 'day' | 'month' | 'year' | null; refs: string[]; provenance: Provenance; sources: SourceRef[]; license: string;
}
export interface DocumentRow {
  id: string; institution: 'commission' | 'parliament' | 'council' | 'publications_office'; doc_type: string; date: string | null; url: string | null;
  access: 'public' | 'limite' | 'not_public'; provenance: Provenance; sources: SourceRef[]; license: string;
}
export interface EdgeRow { edge: string; from: string; to: string; provenance: Provenance; sources: SourceRef[]; license: string }
export interface LegalActRow { celex: string; eli: string | null; oj_ref: string | null; dates: Record<string, string[]>; sources: SourceRef[]; license: string }
export interface GapRow { institution: string; kind: string; reason: string; since: string | null }

// Everything one source says about one procedure in one run.
export interface ProcedureFacts {
  procedure: string;
  source: SourceId;
  header: Partial<{ type: string; slug: string; title: string; ep_stage: string; ep_committees: string[]; cellar_file_status: string; latest_ep_event: string }>;
  identifiers: IdentifierRow[];
  steps: StepRow[];
  documents: DocumentRow[];
  edges: EdgeRow[];
  legal_acts: LegalActRow[];
  gaps: GapRow[];
}

const j = (v: unknown): string => JSON.stringify(v);

// Stable content hash of the facts, without retrieval times (they change on every run).
export function factsHash(f: ProcedureFacts): string {
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'retrieved').sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, strip(x)]))
      : v;
  const sortBy = <T>(xs: T[]) => [...xs].map((x) => j(strip(x))).sort();
  return sha256(j({ h: strip(f.header), i: sortBy(f.identifiers), s: sortBy(f.steps), d: sortBy(f.documents), e: sortBy(f.edges), l: sortBy(f.legal_acts), g: sortBy(f.gaps) }));
}

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'graph.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(DDL);
    // Columns added after the first local run (2026-10-24); existing databases get them here.
    const cols = new Set((this.db.prepare('PRAGMA table_info(fetch_log)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('response_excerpt')) this.db.exec('ALTER TABLE fetch_log ADD COLUMN response_excerpt TEXT');
  }
  close(): void {
    this.db.close();
  }

  beginRun(id: string, started: string, scope: string): void {
    this.db.prepare('INSERT INTO runs (id, started, status, scope) VALUES (?, ?, ?, ?)').run(id, started, 'running', scope);
  }
  finishRun(id: string, finished: string, status: string): string {
    const rows = this.db.prepare('SELECT source, key, sha256 FROM raw_objects WHERE run = ? ORDER BY source, key').all(id) as { source: string; key: string; sha256: string }[];
    const checksum = sha256(rows.map((r) => `${r.source}/${r.key}=${r.sha256}`).join('\n'));
    this.db.prepare('UPDATE runs SET finished = ?, status = ?, checksum = ? WHERE id = ?').run(finished, status, checksum, id);
    return checksum;
  }

  // Raw archive: unchanged body, gzip, SHA-256. Same checksum as in the previous run -> only a reference.
  saveRaw(run: string, source: SourceId, key: string, url: string, retrieved: string, body: Buffer): { sha256: string; path: string } {
    const hash = sha256(body);
    const prev = this.db.prepare('SELECT run, path FROM raw_objects WHERE source = ? AND key = ? AND sha256 = ? ORDER BY run DESC LIMIT 1').get(source, key, hash) as { run: string; path: string } | undefined;
    let path: string;
    let sameAs: string | null = null;
    if (prev && existsSync(join(this.dataDir, prev.path))) {
      path = prev.path;
      sameAs = prev.run;
    } else {
      path = join('raw', source, run.replace(/:/g, ''), `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.gz`).replace(/\\/g, '/');
      const abs = join(this.dataDir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, gzipSync(body));
    }
    this.db.prepare('INSERT OR REPLACE INTO raw_objects (run, source, key, url, retrieved, sha256, bytes, path, same_as_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run, source, key, url, retrieved, hash, body.length, path, sameAs);
    return { sha256: hash, path };
  }

  saveLicenceEvidence(run: string, source: SourceId, url: string, retrieved: string, wording: string): void {
    this.db.prepare('INSERT OR REPLACE INTO licence_evidence (run, source, url, retrieved, wording, sha256) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run, source, url, retrieved, wording, sha256(wording));
  }

  logFetch(run: string, e: FetchLogEntry): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM fetch_log WHERE run = ?').get(run) as { n: number }).n;
    this.db.prepare('INSERT INTO fetch_log (run, seq, source, url, attempt, not_before, started, finished, status, retry_after_s, error, started_ms, finished_ms, retry_after_ms, not_before_ms, response_excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run, seq, e.source, e.url, e.attempt, e.not_before, e.started, e.finished, e.status, e.retry_after_s ?? null, e.error ?? null, e.started_ms, e.finished_ms, e.retry_after_ms ?? null, e.not_before_ms, e.response_excerpt ?? null);
  }

  fetchLog(run: string): (FetchLogEntry & { seq: number })[] {
    return (this.db.prepare('SELECT * FROM fetch_log WHERE run = ? ORDER BY seq').all(run) as Record<string, unknown>[]).map((r) => ({
      seq: r.seq as number, source: r.source as SourceId, url: r.url as string, attempt: r.attempt as number,
      not_before: (r.not_before as string | null) ?? null, not_before_ms: (r.not_before_ms as number | null) ?? null,
      started: r.started as string, started_ms: r.started_ms as number, finished: r.finished as string, finished_ms: r.finished_ms as number,
      status: (r.status as number | null) ?? null, retry_after_s: (r.retry_after_s as number | null) ?? undefined,
      retry_after_ms: (r.retry_after_ms as number | null) ?? undefined, error: (r.error as string | null) ?? undefined,
      response_excerpt: (r.response_excerpt as string | null) ?? undefined,
    }));
  }

  markItem(run: string, source: SourceId, key: string, outcome: 'ok' | 'not_found' | 'failed', note?: string): void {
    this.db.prepare('INSERT OR REPLACE INTO run_items (run, source, key, outcome, note) VALUES (?, ?, ?, ?, ?)').run(run, source, key, outcome, note ?? null);
  }
  doneItems(run: string, source: SourceId): Set<string> {
    return new Set((this.db.prepare("SELECT key FROM run_items WHERE run = ? AND source = ? AND outcome IN ('ok', 'not_found')").all(run, source) as { key: string }[]).map((r) => r.key));
  }
  itemCounts(run: string, source: SourceId, keyPrefix = ''): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT outcome, COUNT(*) AS n FROM run_items WHERE run = ? AND source = ? AND key LIKE ? GROUP BY outcome').all(run, source, `${keyPrefix}%`) as { outcome: string; n: number }[]) out[r.outcome] = r.n;
    return out;
  }
  runRow(id: string): { id: string; started: string; finished: string | null; status: string; scope: string } | undefined {
    return this.db.prepare('SELECT id, started, finished, status, scope FROM runs WHERE id = ?').get(id) as never;
  }

  saveSourceHealth(run: string, h: { source: SourceId; status: 'ok' | 'partial' | 'unavailable'; requests: number; errors: Record<string, number>; median_ms: number | null; p95_ms: number | null; objects: number; objects_failed: number; last_success: string | null; note?: string }): void {
    this.db.prepare('INSERT OR REPLACE INTO source_health (run, source, status, requests, errors, median_ms, p95_ms, objects, objects_failed, last_success, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run, h.source, h.status, h.requests, j(h.errors), h.median_ms, h.p95_ms, h.objects, h.objects_failed, h.last_success, h.note ?? null);
  }

  lastSuccess(source: SourceId): string | null {
    const r = this.db.prepare("SELECT MAX(last_success) AS t FROM source_health WHERE source = ? AND status IN ('ok', 'partial')").get(source) as { t: string | null };
    return r.t;
  }

  ensureProcedure(id: string, type: string, slug: string, run: string): void {
    this.db.prepare('INSERT OR IGNORE INTO procedures (id, type, slug, first_seen_run) VALUES (?, ?, ?, ?)').run(id, type, slug, run);
  }
  setInScope(id: string, inScope: boolean): void {
    this.db.prepare('UPDATE procedures SET in_scope = ? WHERE id = ?').run(inScope ? 1 : 0, id);
  }

  // Replace what one source says about one procedure. Only called after a successful fetch.
  // Returns true if the content differs from the previous state of that source.
  applyFacts(f: ProcedureFacts, run: string): boolean {
    const hash = factsHash(f);
    const prev = this.db.prepare('SELECT hash FROM object_state WHERE procedure = ? AND source = ?').get(f.procedure, f.source) as { hash: string } | undefined;
    const changed = !prev || prev.hash !== hash;
    this.db.exec('BEGIN');
    try {
      const h = f.header;
      const set: string[] = [];
      const vals: (string | null)[] = [];
      for (const [k, v] of Object.entries(h)) {
        if (k === 'type' || k === 'slug') continue;
        set.push(`${k} = ?`);
        vals.push(Array.isArray(v) ? j(v) : (v ?? null));
      }
      if (set.length) this.db.prepare(`UPDATE procedures SET ${set.join(', ')} WHERE id = ?`).run(...vals, f.procedure);
      if (changed) {
        for (const t of ['identifiers', 'steps', 'documents', 'edges', 'legal_acts', 'gaps'])
          this.db.prepare(`DELETE FROM ${t} WHERE procedure = ? AND source = ?`).run(f.procedure, f.source);
        const insId = this.db.prepare('INSERT OR REPLACE INTO identifiers VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const r of f.identifiers) insId.run(f.procedure, r.alias_type, r.alias, f.source, j(r.provenance), j(r.sources), r.license);
        const insStep = this.db.prepare('INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const s of f.steps) insStep.run(f.procedure, s.id, f.source, s.institution, s.kind, s.source_kind ?? null, s.date, s.date_precision, j(s.refs), j(s.provenance), j(s.sources), s.license);
        const insDoc = this.db.prepare('INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const d of f.documents) insDoc.run(f.procedure, d.id, f.source, d.institution, d.doc_type, d.date, d.url, d.access, j(d.provenance), j(d.sources), d.license);
        const insEdge = this.db.prepare('INSERT OR REPLACE INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const e of f.edges) insEdge.run(f.procedure, e.edge, e.from, e.to, f.source, j(e.provenance), j(e.sources), e.license);
        const insAct = this.db.prepare('INSERT OR REPLACE INTO legal_acts VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const a of f.legal_acts) insAct.run(f.procedure, a.celex, a.eli, a.oj_ref, j(a.dates), f.source, j(a.sources), a.license);
        const insGap = this.db.prepare('INSERT OR REPLACE INTO gaps VALUES (?, ?, ?, ?, ?, ?)');
        for (const g of f.gaps) insGap.run(f.procedure, g.institution, g.kind, g.reason, g.since, f.source);
        this.db.prepare('INSERT OR REPLACE INTO object_state (procedure, source, hash, changed_run, checked_run) VALUES (?, ?, ?, ?, ?)').run(f.procedure, f.source, hash, run, run);
      } else {
        this.db.prepare('UPDATE object_state SET checked_run = ? WHERE procedure = ? AND source = ?').run(run, f.procedure, f.source);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  }

  // Digest of everything stored about a procedure (all sources, all tables). Used for criterion K4.
  procedureDigest(id: string): string {
    const parts: unknown[] = [this.db.prepare('SELECT * FROM procedures WHERE id = ?').get(id)];
    for (const t of ['object_state', 'identifiers', 'steps', 'documents', 'edges', 'legal_acts', 'gaps'])
      parts.push(this.db.prepare(`SELECT * FROM ${t} WHERE procedure = ? ORDER BY 1, 2, 3, 4`).all(id));
    return sha256(j(parts));
  }

  resolve(aliasType: string, alias: string): string[] {
    return (this.db.prepare('SELECT DISTINCT procedure FROM identifiers WHERE alias_type = ? AND alias = ? ORDER BY procedure').all(aliasType, alias) as { procedure: string }[]).map((r) => r.procedure);
  }
}
