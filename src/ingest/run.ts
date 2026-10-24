// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// One ingestion run (05-architektur.md 2): Q1 EP API, then Q2 Cellar, one source after the other,
// raw archive, source health, fetch log. A run is the unit of versioning (05-architektur.md 2.3).

import { iso, systemClock, type Clock } from './clock.ts';
import { actsQuery, addActs, BATCH, CELLAR_LEGAL_BASIS, CELLAR_LICENSE, cellarFacts, parseWorks, SPARQL_ENDPOINT, worksQuery, type CellarDossier } from './cellar.ts';
import { EP_LEGAL_BASIS, EP_LICENSE, inScope, listUrl, parseList, parseProcedure, procedureUrl, LIST_LIMIT } from './ep.ts';
import { CELLAR_POLICY, EP_POLICY, FetchFailed, fetchTransport, PoliteClient, retryAfterViolations, SourceBlocked, type FetchLogEntry, type SourceId, type Transport } from './http.ts';
import { parseProcedureNumber, procSlug, processId } from './ids.ts';
import { fetchLicenceEvidence } from './licence.ts';
import { Store, type SourceRef } from './store.ts';

export interface RunOptions {
  dataDir: string;
  // Which EP procedures to fetch:
  //   explicit: these procedure numbers only (e.g. the reference cases)
  //   frame:    all procedures of the types in the EP lists of these years; the scope is set from the events
  //   scope:    all procedures marked in scope by an earlier run, plus the lists of the current and previous year
  select: { mode: 'explicit'; procedures: string[] } | { mode: 'frame'; types: string[]; years: number[] } | { mode: 'scope'; types: string[] };
  clock?: Clock;
  transports?: Partial<Record<SourceId, Transport>>;
  policies?: { ep?: typeof EP_POLICY; cellar?: typeof CELLAR_POLICY };
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

function errorsOf(log: FetchLogEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of log) {
    const k = e.status === null ? 'network' : e.status >= 400 ? String(e.status) : null;
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export async function runIngestion(opts: RunOptions): Promise<RunSummary> {
  const clock = opts.clock ?? systemClock;
  const say = opts.log ?? (() => {});
  const store = new Store(opts.dataDir);
  const t0 = clock.now();
  const run = iso(t0);
  const scopeText = JSON.stringify(opts.select);
  store.beginRun(run, run, scopeText);
  const ep = new PoliteClient(opts.policies?.ep ?? EP_POLICY, clock, opts.transports?.ep_api ?? fetchTransport);
  const cellar = new PoliteClient(opts.policies?.cellar ?? CELLAR_POLICY, clock, opts.transports?.cellar ?? fetchTransport);
  const sources: SourceSummary[] = [];
  const unmapped = new Set<string>();
  let changed = 0;
  let unchanged = 0;
  let licence: RunSummary['licence'] = [];
  let licenceNotReachable: string[] = [];

  try {
    if (opts.licenceEvidence !== false) {
      const l = await fetchLicenceEvidence(ep, cellar, clock);
      licence = l.evidence;
      licenceNotReachable = l.notReachable;
      for (const e of l.evidence) store.saveLicenceEvidence(run, e.source, e.url, e.retrieved, e.wording);
    }

    // ---- Q1 EP API
    const epSum: SourceSummary = { source: 'ep_api', status: 'ok', requests: 0, objects: 0, objectsFailed: 0, errors: {} };
    const targets = new Map<string, string>(); // processId -> type
    let blocked: string | null = null;
    try {
      if (opts.select.mode === 'explicit') {
        for (const p of opts.select.procedures) {
          const n = parseProcedureNumber(p);
          if (!n) throw new Error(`not a procedure number: ${p}`);
          targets.set(processId(n), n.type);
        }
      } else {
        const years = opts.select.mode === 'frame' ? opts.select.years : [new Date(t0).getUTCFullYear() - 1, new Date(t0).getUTCFullYear()];
        for (const type of opts.select.types) {
          for (const year of years) {
            for (let offset = 0; ; offset += LIST_LIMIT) {
              const url = listUrl(type, year, offset);
              const res = await ep.request(url, { headers: { Accept: 'application/ld+json' } });
              if (res.status !== 200) throw new FetchFailed('ep_api', url, res.status, `list ${type} ${year}: HTTP ${res.status}`);
              store.saveRaw(run, 'ep_api', `list-${type}-${year}-${offset}`, url, iso(clock.now()), res.body);
              const page = parseList(res.body);
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
      say(`ep_api: ${targets.size} procedures to fetch`);
      let consecutive = 0;
      let ok = 0;
      for (const [pid, type] of targets) {
        const url = procedureUrl(pid);
        try {
          const res = await ep.request(url, { headers: { Accept: 'application/ld+json' } });
          if (res.status === 404) {
            epSum.objectsFailed++;
            continue;
          }
          if (res.status !== 200) throw new FetchFailed('ep_api', url, res.status, `HTTP ${res.status}`);
          const retrieved = iso(clock.now());
          const n = parseProcedureNumber(pid, type)!;
          store.ensureProcedure(`${n.year}/${n.number}(${type})`, type, procSlug(n), run);
          const ref: SourceRef = { source: 'ep_api', url, ref: `eli/dl/proc/${pid}`, retrieved, license: EP_LICENSE, legal_basis: EP_LEGAL_BASIS };
          const parsed = parseProcedure(res.body, ref);
          const scoped = inScope(parsed.latestEvent);
          if (scoped || opts.select.mode === 'explicit') store.saveRaw(run, 'ep_api', `procedure-${pid}`, url, retrieved, res.body);
          parsed.unmappedActivityTypes.forEach((t) => unmapped.add(t));
          if (store.applyFacts(parsed.facts, run)) changed++;
          else unchanged++;
          store.setInScope(parsed.facts.procedure, scoped);
          epSum.objects++;
          ok++;
          consecutive = 0;
        } catch (err) {
          if (err instanceof SourceBlocked) throw err;
          epSum.objectsFailed++;
          consecutive++;
          say(`ep_api: ${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (ok === 0 || consecutive >= CONSECUTIVE_FAILURES_STOP) {
            blocked = ok === 0 ? 'nothing came; source stopped for this run' : `${consecutive} procedures in a row failed; source stopped for this run`;
            break;
          }
        }
      }
    } catch (err) {
      blocked = err instanceof Error ? err.message : String(err);
    }
    epSum.requests = ep.log.length;
    epSum.errors = errorsOf(ep.log);
    if (blocked) {
      epSum.status = epSum.objects === 0 ? 'unavailable' : 'partial';
      epSum.note = blocked;
    } else if (epSum.objectsFailed > 0) epSum.status = 'partial';
    sources.push(epSum);

    // ---- Q2 Cellar, for the procedures fetched from the EP in this run (explicit: the given ones)
    const cSum: SourceSummary = { source: 'cellar', status: 'ok', requests: 0, objects: 0, objectsFailed: 0, errors: {} };
    const procs = opts.select.mode === 'explicit'
      ? opts.select.procedures.map((p) => `${parseProcedureNumber(p)!.year}/${parseProcedureNumber(p)!.number}(${parseProcedureNumber(p)!.type})`)
      : (store.db.prepare('SELECT id FROM procedures WHERE in_scope = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    let cBlocked: string | null = null;
    let cOk = 0;
    let cConsecutive = 0;
    for (let i = 0; i < procs.length; i += BATCH) {
      const batch = procs.slice(i, i + BATCH);
      try {
        const dossiers = new Map<string, CellarDossier>();
        for (const [name, query] of [['works', worksQuery(batch)], ['acts', actsQuery(batch)]] as const) {
          const res = await cellar.request(SPARQL_ENDPOINT, {
            method: 'POST',
            headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ query }).toString(),
          });
          if (res.status !== 200) throw new FetchFailed('cellar', SPARQL_ENDPOINT, res.status, `HTTP ${res.status}`);
          store.saveRaw(run, 'cellar', `${name}-${i / BATCH}`, SPARQL_ENDPOINT, iso(clock.now()), Buffer.concat([Buffer.from(`# ${query.replace(/\n/g, '\n# ')}\n`), res.body]));
          const json = JSON.parse(res.body.toString('utf8'));
          if (name === 'works') for (const [k, d] of parseWorks(json)) dossiers.set(k, d);
          else addActs(dossiers, json);
        }
        const retrieved = iso(clock.now());
        const ref: SourceRef = { source: 'cellar', url: SPARQL_ENDPOINT, retrieved, license: CELLAR_LICENSE, legal_basis: CELLAR_LEGAL_BASIS };
        for (const p of batch) {
          const d = dossiers.get(p) ?? { procedure: p, fileStatus: null, works: [], acts: new Map() };
          const n = parseProcedureNumber(p)!;
          store.ensureProcedure(p, n.type, procSlug(n), run);
          const facts = cellarFacts(d, ref);
          if (!dossiers.has(p)) facts.gaps.push({ institution: 'council', kind: 'cellar_dossier', reason: 'cellar_lag', since: null });
          if (store.applyFacts(facts, run)) changed++;
          else unchanged++;
          cSum.objects++;
        }
        cOk++;
        cConsecutive = 0;
      } catch (err) {
        if (err instanceof SourceBlocked) {
          cBlocked = err.message;
          break;
        }
        cSum.objectsFailed += batch.length;
        cConsecutive++;
        say(`cellar: batch ${i / BATCH} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (cOk === 0 || cConsecutive >= CONSECUTIVE_FAILURES_STOP) {
          cBlocked = cOk === 0 ? 'nothing came; source stopped for this run' : `${cConsecutive} batches in a row failed; source stopped for this run`;
          break;
        }
      }
    }
    cSum.requests = cellar.log.length;
    cSum.errors = errorsOf(cellar.log);
    if (cBlocked) {
      cSum.status = cSum.objects === 0 ? 'unavailable' : 'partial';
      cSum.note = cBlocked;
    } else if (cSum.objectsFailed > 0) cSum.status = 'partial';
    sources.push(cSum);
  } finally {
    const log = [...ep.log, ...cellar.log].sort((a, b) => a.started_ms - b.started_ms);
    store.saveFetchLog(run, log);
    const now = iso(clock.now());
    for (const s of sources) {
      const own = log.filter((e) => e.source === s.source && e.status !== null && e.status < 400);
      const ms = own.map((e) => e.finished_ms - e.started_ms);
      store.saveSourceHealth(run, {
        source: s.source, status: s.status, requests: s.requests, errors: s.errors,
        median_ms: quantile(ms, 0.5), p95_ms: quantile(ms, 0.95), objects: s.objects, objects_failed: s.objectsFailed,
        last_success: s.status === 'unavailable' ? store.lastSuccess(s.source) : now, note: s.note,
      });
    }
  }

  const finished = clock.now();
  const status = sources.every((s) => s.status === 'ok') ? 'ok' : 'degraded';
  const checksum = store.finishRun(run, iso(finished), status);
  const log = [...ep.log, ...cellar.log].sort((a, b) => a.started_ms - b.started_ms);
  const inScopeCount = (store.db.prepare('SELECT COUNT(*) AS n FROM procedures WHERE in_scope = 1').get() as { n: number }).n;
  store.close();
  return {
    run, started: run, finished: iso(finished), durationS: Math.round((finished - t0) / 1000), checksum, sources,
    procedures: { fetched: sources[0]?.objects ?? 0, inScope: inScopeCount, changed, unchanged },
    unmappedActivityTypes: [...unmapped].sort(),
    licence,
    licenceNotReachable,
    retryAfterViolations: retryAfterViolations(log).length,
    fetchLog: log,
  };
}

