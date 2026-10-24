// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// One ingestion run (05-architektur.md 2): licence wording, Q1 EP API (procedures feed as a hint, lists,
// procedure objects), then Q2 Cellar; one source after the other, raw archive, source health, fetch log.
// A run is the unit of versioning (05-architektur.md 2.3). Every fetched object is recorded in run_items
// and every attempt in fetch_log as it happens, so an aborted run is resumed where it stopped
// (--resume <run>), with the throttle state restored from its fetch log.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { iso, systemClock, type Clock } from './clock.ts';
import { actsQuery, addActs, BATCH, CELLAR_LEGAL_BASIS, CELLAR_LICENSE, cellarFacts, parseWorks, SPARQL_ENDPOINT, worksQuery, type CellarDossier } from './cellar.ts';
import { EP_LEGAL_BASIS, EP_LICENSE, feedUrl, inScope, LIST_LIMIT, listUrl, parseList, parseProcedure, procedureUrl, SCOPE_FROM } from './ep.ts';
import { CELLAR_POLICY, EP_POLICY, FetchFailed, fetchTransport, PoliteClient, retryAfterViolations, SourceBlocked, type FetchLogEntry, type SourceId, type SourcePolicy, type Transport } from './http.ts';
import { parseProcedureNumber, procSlug, processId } from './ids.ts';
import { fetchLicenceEvidence } from './licence.ts';
import { Store, type SourceRef } from './store.ts';

export type Selection =
  | { mode: 'explicit'; procedures: string[] } // these procedure numbers only (e.g. the reference cases)
  | { mode: 'frame'; types: string[]; years: number[] } // all procedures of the EP lists of these years; scope from the events
  | { mode: 'scope'; types: string[] }; // in scope from earlier runs, the lists of this and last year, and the feed hints

export interface RunOptions {
  dataDir: string;
  select: Selection;
  resume?: string;
  clock?: Clock;
  transports?: Partial<Record<'ep_api' | 'cellar', Transport>>;
  policies?: { ep?: SourcePolicy; cellar?: SourcePolicy };
  licenceEvidence?: boolean;
  log?: (line: string) => void;
}

export interface SourceSummary {
  source: SourceId;
  status: 'ok' | 'partial' | 'unavailable';
  requests: number;
  objects: number;
  objectsFailed: number;
  errors: Record<string, number>;
  note?: string;
}
export interface RunSummary {
  run: string;
  started: string;
  finished: string;
  durationS: number;
  resumed: boolean;
  checksum: string;
  sources: SourceSummary[];
  procedures: { fetched: number; inScope: number; changed: number; unchanged: number };
  unmappedActivityTypes: string[];
  licence: { source: SourceId; url: string; retrieved: string; wording: string }[];
  licenceNotReachable: string[];
  retryAfterViolations: number;
  fetchLog: FetchLogEntry[];
}

const CONSECUTIVE_FAILURES_STOP = 3;

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runIngestion(opts: RunOptions): Promise<RunSummary> {
  const clock = opts.clock ?? systemClock;
  const say = opts.log ?? (() => {});
  const store = new Store(opts.dataDir);
  const t0 = clock.now();
  let run: string;
  let resumed = false;
  if (opts.resume) {
    const row = store.runRow(opts.resume);
    if (!row) throw new Error(`run ${opts.resume} not found`);
    if (row.finished) throw new Error(`run ${opts.resume} is finished; nothing to resume`);
    if (row.scope !== JSON.stringify(opts.select)) throw new Error(`run ${opts.resume} was started with another selection: ${row.scope}`);
    run = row.id;
    resumed = true;
  } else {
    run = iso(t0);
    store.beginRun(run, run, JSON.stringify(opts.select));
  }
  const persist = (e: FetchLogEntry) => store.logFetch(run, e);
  const ep = new PoliteClient(opts.policies?.ep ?? EP_POLICY, clock, opts.transports?.ep_api ?? fetchTransport, persist);
  const cellar = new PoliteClient(opts.policies?.cellar ?? CELLAR_POLICY, clock, opts.transports?.cellar ?? fetchTransport, persist);
  if (resumed) {
    const prior = store.fetchLog(run);
    ep.prime(prior.filter((e) => e.source === 'ep_api' || e.source === 'ep_feed'));
    cellar.prime(prior.filter((e) => e.source === 'cellar'));
    say(`resuming run ${run}: ${prior.length} earlier requests`);
  }
  const notes: Partial<Record<SourceId, string>> = {};
  const unmapped = new Set<string>();
  let changed = 0;
  let unchanged = 0;
  let licence: RunSummary['licence'] = [];
  let licenceNotReachable: string[] = [];
  const epHeaders = { Accept: 'application/ld+json' };

  // ---- licence wording (once per run)
  if (opts.licenceEvidence !== false) {
    const have = store.db.prepare('SELECT COUNT(*) AS n FROM licence_evidence WHERE run = ?').get(run) as { n: number };
    if (have.n === 0) {
      const l = await fetchLicenceEvidence(ep, cellar, clock);
      licence = l.evidence;
      licenceNotReachable = l.notReachable;
      for (const e of l.evidence) store.saveLicenceEvidence(run, e.source, e.url, e.retrieved, e.wording);
    } else {
      licence = store.db.prepare('SELECT source, url, retrieved, wording FROM licence_evidence WHERE run = ?').all(run) as never;
    }
  }

  // ---- EP procedures feed: only a hint on changed procedures (04-datenquellen.md Q1), never the source of truth
  const targets = new Map<string, string>(); // processId -> type
  const types = opts.select.mode === 'explicit' ? [...new Set(opts.select.procedures.map((p) => parseProcedureNumber(p)?.type).filter((t): t is string => !!t))] : opts.select.types;
  const feedDone = store.doneItems(run, 'ep_feed');
  for (const type of types) {
    const since = (store.lastSuccess('ep_feed') ?? store.lastSuccess('ep_api') ?? SCOPE_FROM).slice(0, 10);
    const key = `feed-${type}`;
    if (feedDone.has(key)) continue;
    const url = feedUrl(type, since);
    try {
      const res = await ep.request(url, { headers: epHeaders, as: 'ep_feed' });
      if (res.status !== 200) throw new FetchFailed('ep_feed', url, res.status, `HTTP ${res.status}`);
      store.saveRaw(run, 'ep_feed', key, url, iso(clock.now()), res.body);
      const page = parseList(res.body);
      if (opts.select.mode === 'scope') for (const x of page.ids) targets.set(x.processId, x.type || type);
      store.markItem(run, 'ep_feed', key, 'ok', `${page.ids.length} procedures since ${since}`);
    } catch (err) {
      if (err instanceof SourceBlocked) notes.ep_feed = err.message;
      store.markItem(run, 'ep_feed', key, 'failed', errText(err));
      notes.ep_feed = errText(err);
      say(`ep_feed: ${errText(err)}`);
    }
  }

  // ---- Q1 EP API
  let epBlocked: string | null = null;
  try {
    if (opts.select.mode === 'explicit') {
      for (const p of opts.select.procedures) {
        const n = parseProcedureNumber(p);
        if (!n) throw new Error(`not a procedure number: ${p}`);
        targets.set(processId(n), n.type);
      }
    } else {
      const years = opts.select.mode === 'frame' ? opts.select.years : [new Date(t0).getUTCFullYear() - 1, new Date(t0).getUTCFullYear()];
      const done = store.doneItems(run, 'ep_api');
      for (const type of opts.select.types) {
        for (const year of years) {
          for (let offset = 0; ; offset += LIST_LIMIT) {
            const key = `list-${type}-${year}-${offset}`;
            const url = listUrl(type, year, offset);
            let body: Buffer;
            if (done.has(key)) {
              const row = store.db.prepare("SELECT path FROM raw_objects WHERE run = ? AND source = 'ep_api' AND key = ?").get(run, key) as { path: string };
              body = gunzipSync(readFileSync(join(opts.dataDir, row.path)));
            } else {
              const res = await ep.request(url, { headers: epHeaders });
              if (res.status !== 200) throw new FetchFailed('ep_api', url, res.status, `list ${type} ${year}: HTTP ${res.status}`);
              body = res.body;
              store.saveRaw(run, 'ep_api', key, url, iso(clock.now()), body);
            }
            const page = parseList(body);
            if (!done.has(key)) store.markItem(run, 'ep_api', key, 'ok', `${page.ids.length} of ${page.total}`);
            for (const x of page.ids) targets.set(x.processId, x.type || type);
            if (page.ids.length < LIST_LIMIT || offset + LIST_LIMIT >= page.total) break;
          }
        }
      }
      if (opts.select.mode === 'scope') {
        const rows = store.db.prepare(`SELECT id, type FROM procedures WHERE in_scope = 1 AND type IN (${opts.select.types.map(() => '?').join(',')})`).all(...opts.select.types) as { id: string; type: string }[];
        for (const r of rows) targets.set(processId(parseProcedureNumber(r.id)!), r.type);
      }
    }
    const done = store.doneItems(run, 'ep_api');
    const todo = [...targets].filter(([pid]) => !done.has(`procedure-${pid}`));
    say(`ep_api: ${targets.size} procedures, ${targets.size - todo.length} already done in this run, ${todo.length} to fetch`);
    let consecutive = 0;
    let okCount = targets.size - todo.length;
    let i = 0;
    for (const [pid, type] of todo) {
      const url = procedureUrl(pid);
      const key = `procedure-${pid}`;
      if (++i % 100 === 0) say(`ep_api: ${i}/${todo.length}`);
      try {
        const res = await ep.request(url, { headers: epHeaders });
        if (res.status === 404) {
          store.markItem(run, 'ep_api', key, 'not_found');
          continue;
        }
        if (res.status !== 200) throw new FetchFailed('ep_api', url, res.status, `HTTP ${res.status}`);
        const retrieved = iso(clock.now());
        const ref: SourceRef = { source: 'ep_api', url, ref: `eli/dl/proc/${pid}`, retrieved, license: EP_LICENSE, legal_basis: EP_LEGAL_BASIS };
        const parsed = parseProcedure(res.body, ref);
        const n = parseProcedureNumber(parsed.facts.procedure)!;
        store.ensureProcedure(parsed.facts.procedure, n.type, procSlug(n), run);
        const scoped = inScope(parsed.latestEvent);
        // Raw archive for every procedure in scope (and for explicitly requested ones); out of scope only the checksum.
        if (scoped || opts.select.mode === 'explicit') store.saveRaw(run, 'ep_api', key, url, retrieved, res.body);
        parsed.unmappedActivityTypes.forEach((t) => unmapped.add(t));
        if (store.applyFacts(parsed.facts, run)) changed++;
        else unchanged++;
        store.setInScope(parsed.facts.procedure, scoped);
        store.markItem(run, 'ep_api', key, 'ok', scoped ? 'in scope' : `out of scope (latest event ${parsed.latestEvent ?? 'none'})`);
        okCount++;
        consecutive = 0;
        void type;
      } catch (err) {
        if (err instanceof SourceBlocked) throw err;
        store.markItem(run, 'ep_api', key, 'failed', errText(err));
        consecutive++;
        say(`ep_api: ${pid} failed: ${errText(err)}`);
        if (okCount === 0 || consecutive >= CONSECUTIVE_FAILURES_STOP) {
          epBlocked = okCount === 0 ? 'nothing came; source stopped for this run' : `${consecutive} procedures in a row failed; source stopped for this run`;
          break;
        }
      }
    }
  } catch (err) {
    epBlocked = errText(err);
  }
  if (epBlocked) notes.ep_api = epBlocked;

  // ---- Q2 Cellar, for the procedures in scope (explicit: the given ones)
  const procs = opts.select.mode === 'explicit'
    ? opts.select.procedures.map((p) => {
        const n = parseProcedureNumber(p)!;
        return `${n.year}/${n.number}(${n.type})`;
      })
    : (store.db.prepare('SELECT id FROM procedures WHERE in_scope = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  const cDone = store.doneItems(run, 'cellar');
  let cOk = 0;
  let cConsecutive = 0;
  for (let i = 0; i < procs.length; i += BATCH) {
    const batch = procs.slice(i, i + BATCH);
    const key = `batch-${i / BATCH}-${batch[0]}`;
    if (cDone.has(key)) {
      cOk++;
      continue;
    }
    try {
      const dossiers = new Map<string, CellarDossier>();
      for (const [name, query] of [['works', worksQuery(batch)], ['acts', actsQuery(batch)]] as const) {
        const res = await cellar.request(SPARQL_ENDPOINT, {
          method: 'POST',
          headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ query }).toString(),
        });
        if (res.status !== 200) throw new FetchFailed('cellar', SPARQL_ENDPOINT, res.status, `HTTP ${res.status}`);
        store.saveRaw(run, 'cellar', `${name}-${key}`, SPARQL_ENDPOINT, iso(clock.now()), Buffer.concat([Buffer.from(`# ${query.replace(/\n/g, '\n# ')}\n`), res.body]));
        const json = JSON.parse(res.body.toString('utf8'));
        if (name === 'works') for (const [k, d] of parseWorks(json)) dossiers.set(k, d);
        else addActs(dossiers, json);
      }
      const ref: SourceRef = { source: 'cellar', url: SPARQL_ENDPOINT, retrieved: iso(clock.now()), license: CELLAR_LICENSE, legal_basis: CELLAR_LEGAL_BASIS };
      for (const p of batch) {
        const n = parseProcedureNumber(p)!;
        store.ensureProcedure(p, n.type, procSlug(n), run);
        const facts = cellarFacts(dossiers.get(p) ?? { procedure: p, fileStatus: null, works: [], acts: new Map() }, ref);
        if (!dossiers.has(p)) facts.gaps.push({ institution: 'council', kind: 'cellar_dossier', reason: 'cellar_lag', since: null });
        if (store.applyFacts(facts, run)) changed++;
        else unchanged++;
      }
      store.markItem(run, 'cellar', key, 'ok', `${batch.length} procedures, ${dossiers.size} dossiers`);
      cOk++;
      cConsecutive = 0;
    } catch (err) {
      store.markItem(run, 'cellar', key, 'failed', errText(err));
      if (err instanceof SourceBlocked) {
        notes.cellar = err.message;
        break;
      }
      cConsecutive++;
      say(`cellar: ${key} failed: ${errText(err)}`);
      if (cOk === 0 || cConsecutive >= CONSECUTIVE_FAILURES_STOP) {
        notes.cellar = cOk === 0 ? 'nothing came; source stopped for this run' : `${cConsecutive} batches in a row failed; source stopped for this run`;
        break;
      }
    }
  }

  // ---- source health from the stored log and items of the whole run (also across a resume)
  const log = store.fetchLog(run);
  const now = iso(clock.now());
  const sources: SourceSummary[] = [];
  for (const source of ['ep_feed', 'ep_api', 'cellar'] as const) {
    const own = log.filter((e) => e.source === source);
    if (!own.length && source === 'ep_feed') continue;
    const counts = store.itemCounts(run, source);
    const objects = (counts.ok ?? 0) + (counts.not_found ?? 0);
    const failed = counts.failed ?? 0;
    const errors: Record<string, number> = {};
    for (const e of own) {
      const k = e.status === null ? 'network' : e.status >= 400 ? String(e.status) : null;
      if (k) errors[k] = (errors[k] ?? 0) + 1;
    }
    const status: SourceSummary['status'] = notes[source] ? (objects === 0 ? 'unavailable' : 'partial') : failed > 0 ? 'partial' : 'ok';
    const ms = own.filter((e) => e.status !== null && e.status < 400).map((e) => e.finished_ms - e.started_ms);
    sources.push({ source, status, requests: own.length, objects, objectsFailed: failed, errors, note: notes[source] });
    store.saveSourceHealth(run, {
      source, status, requests: own.length, errors, median_ms: quantile(ms, 0.5), p95_ms: quantile(ms, 0.95), objects, objects_failed: failed,
      last_success: status === 'unavailable' ? store.lastSuccess(source) : now, note: notes[source],
    });
  }

  const finished = clock.now();
  const status = sources.every((s) => s.status === 'ok') ? 'ok' : 'degraded';
  const checksum = store.finishRun(run, iso(finished), status);
  const inScopeCount = (store.db.prepare('SELECT COUNT(*) AS n FROM procedures WHERE in_scope = 1').get() as { n: number }).n;
  const fetched = store.itemCounts(run, 'ep_api', 'procedure-');
  store.close();
  return {
    run, started: run, finished: iso(finished), durationS: Math.round((finished - Date.parse(run)) / 1000), resumed, checksum, sources,
    procedures: { fetched: (fetched.ok ?? 0), inScope: inScopeCount, changed, unchanged },
    unmappedActivityTypes: [...unmapped].sort(),
    licence,
    licenceNotReachable,
    retryAfterViolations: retryAfterViolations(log).length,
    fetchLog: log,
  };
}
