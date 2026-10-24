// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Tests for M1 (08-modulplan.md): fetchers with throttling, Retry-After and retries (K2), identifiers and
// rules R1, R2, R4, R9, the Cellar values of the reference cases (K3, Cellar part), and a simulated
// source outage that changes nothing about a procedure (K4). No network: transports are replaced.

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ManualClock } from '../src/ingest/clock.ts';
import { addActs, cellarFacts, parseWorks, type SparqlResult } from '../src/ingest/cellar.ts';
import { parseProcedure } from '../src/ingest/ep.ts';
import {
  CELLAR_POLICY, EP_POLICY, FetchFailed, parseRetryAfter, PoliteClient, retryAfterViolations, SourceBlocked,
  type HttpRequest, type HttpResponse, type Transport,
} from '../src/ingest/http.ts';
import { canonicalProcedure, normaliseCommissionDoc, normaliseCouncilDoc, registerToEpDoc, epDocToRegister } from '../src/ingest/ids.ts';
import { runIngestion } from '../src/ingest/run.ts';
import { Store } from '../src/ingest/store.ts';
import { expected } from './helpers.ts';

const fixture = (p: string): Buffer => readFileSync(new URL(`./fixtures/${p}`, import.meta.url));
const json = (p: string) => JSON.parse(fixture(p).toString('utf8'));
const ok = (body: string | Buffer, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.isBuffer(body) ? body : Buffer.from(body) });
const status = (code: number, headers: Record<string, string> = {}): HttpResponse => ({ status: code, headers, body: Buffer.from(code === 202 ? '' : `status ${code}`) });

function scripted(responses: (HttpResponse | Error)[]): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (req: HttpRequest) => {
    calls.push(req);
    const r = responses.shift() ?? ok('{}');
    if (r instanceof Error) throw r;
    return r;
  }) as Transport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

describe('identifiers (R1, R2, normalisation)', () => {
  it('R1 maps the three spellings of the procedure number to the EP form', () => {
    assert.equal(canonicalProcedure('2025/0102(COD)'), '2025/0102(COD)');
    assert.equal(canonicalProcedure('2025/0102/COD'), '2025/0102(COD)');
    assert.equal(canonicalProcedure('2025/0102 (COD)'), '2025/0102(COD)');
    assert.equal(canonicalProcedure('eli/dl/proc/2025-0102', 'COD'), '2025/0102(COD)');
    assert.equal(canonicalProcedure('2025-0102'), null, 'process_id without type is not resolved');
  });
  it('R2 links register notation and EP document id both ways', () => {
    assert.equal(registerToEpDoc('P10_A(2025)0272'), 'A-10-2025-0272');
    assert.equal(registerToEpDoc('P10_TA(2026)0001'), 'TA-10-2026-0001');
    assert.equal(registerToEpDoc('SANT_PR(2025)775742'), 'SANT-PR-775742');
    assert.equal(registerToEpDoc('CJ40_AG(2024)758862'), 'CJ40-AG-758862');
    assert.equal(epDocToRegister('A-10-2025-0272'), 'P10_A(2025)0272');
    assert.equal(registerToEpDoc('P10_PV(2026)01-19-ITM-014'), null, 'minutes are no document of the schema');
  });
  it('normalises Commission and Council documents as published in the schema', () => {
    assert.deepEqual(normaliseCommissionDoc('immc:COM(2021)206 final'), { type: 'com', id: 'COM(2021)206' });
    assert.deepEqual(normaliseCommissionDoc('COM(2021)0206'), { type: 'com', id: 'COM(2021)206' });
    assert.deepEqual(normaliseCommissionDoc('immc:C(2026)4534'), { type: 'c_code', id: 'C(2026)4534' });
    assert.equal(normaliseCouncilDoc('consil/ST_6872_2025_INIT'), 'ST 6872/25');
    assert.equal(normaliseCouncilDoc('consil/ST_10915_2026_REV_2'), 'ST 10915/2/26 REV 2');
    assert.equal(normaliseCouncilDoc('consil/WK_10372_2025_ADD_1'), 'WK 10372/25 ADD 1');
    assert.equal(normaliseCouncilDoc('consil/ST_15503_2025_ADD_1_REV_1'), 'ST 15503/1/25 REV 1 ADD 1');
    assert.equal(normaliseCouncilDoc('consil/PE_24_2024_REV_1'), 'PE-CONS 24/1/24 REV 1');
    assert.equal(normaliseCouncilDoc('consil/ST_10060_2026_REV_3_COR_1_REV_1'), null);
  });
});

describe('polite client (throttling, Retry-After, retries)', () => {
  const policy = { ...EP_POLICY, retryDelaysMs: [30_000, 120_000, 600_000] };

  it('keeps at least 2 s between requests and at most 100 in 5 minutes', async () => {
    const clock = new ManualClock();
    const c = new PoliteClient(policy, clock, scripted([]));
    for (let i = 0; i < 205; i++) await c.request(`https://example.test/${i}`);
    const starts = c.log.map((e) => e.started_ms);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2_000);
    for (let i = 100; i < starts.length; i++) assert.ok(starts[i] - starts[i - 100] >= 300_000, `window at ${i}`);
  });

  it('starts no request before Retry-After has expired, and then goes at half speed', async () => {
    const clock = new ManualClock();
    const c = new PoliteClient(policy, clock, scripted([status(429, { 'retry-after': '60' }), ok('{}'), ok('{}'), ok('{}')]));
    await c.request('https://example.test/a');
    await c.request('https://example.test/b');
    await c.request('https://example.test/c');
    const [first, retry, b, cc] = c.log;
    assert.equal(first.status, 429);
    assert.equal(first.retry_after_s, 60);
    assert.ok(retry.started_ms >= first.finished_ms + 60_000);
    assert.ok(retry.not_before !== null);
    assert.ok(b.started_ms - retry.started_ms >= 4_000, 'interval doubled after 429');
    assert.ok(cc.started_ms - b.started_ms >= 4_000);
    assert.deepEqual(retryAfterViolations(c.log), []);
    assert.equal(c.currentIntervalMs, 4_000);
  });

  it('obeys Retry-After as an HTTP date', async () => {
    const clock = new ManualClock();
    const until = new Date(clock.now() + 90_000).toUTCString();
    const c = new PoliteClient(policy, clock, scripted([status(503, { 'retry-after': until }), ok('{}')]));
    await c.request('https://example.test/a');
    assert.ok(c.log[1].started_ms >= Date.parse(until));
    assert.equal(parseRetryAfter('120', 0), 120_000);
    assert.equal(parseRetryAfter(undefined, 0), null);
  });

  it('the log check finds a request that started too early', () => {
    const log = [
      { source: 'ep_api' as const, url: 'a', attempt: 1, not_before: null, not_before_ms: null, started: '', started_ms: 0, finished: '', finished_ms: 1_000, status: 429, retry_after_s: 60, retry_after_ms: 60_000 },
      { source: 'ep_api' as const, url: 'a', attempt: 2, not_before: null, not_before_ms: null, started: '', started_ms: 30_000, finished: '', finished_ms: 31_000, status: 200 },
    ];
    assert.equal(retryAfterViolations(log).length, 1);
  });

  it('retries three times with growing waits, then gives up', async () => {
    const clock = new ManualClock();
    const c = new PoliteClient(policy, clock, scripted([status(500), status(502), new Error('timeout'), status(503)]));
    await assert.rejects(c.request('https://example.test/a'), FetchFailed);
    const s = c.log.map((e) => e.started_ms);
    assert.equal(c.log.length, 4);
    assert.ok(s[1] - s[0] >= 30_000 && s[2] - s[1] >= 120_000 && s[3] - s[2] >= 600_000);
  });

  it('stops at once on 403, on HTTP 202 without content and on a challenge page', async () => {
    for (const r of [status(403), status(202), { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>awswaf captcha</html>') }]) {
      const c = new PoliteClient(CELLAR_POLICY, new ManualClock(), scripted([r]));
      await assert.rejects(c.request('https://example.test/a'), SourceBlocked);
      assert.equal(c.log.length, 1, 'no retry, no workaround');
    }
  });

  it('sends the User-Agent in the EP format without names', async () => {
    const t = scripted([]);
    await new PoliteClient(policy, new ManualClock(), t).request('https://example.test/a');
    assert.match(t.calls[0].headers['User-Agent'], /^berth-regesta-prod-\d+\.\d+\.\d+$/);
  });
});

describe('Cellar (R1, R2, R4, R9) against the reference cases', () => {
  const ref = { source: 'cellar' as const, url: 'https://publications.europa.eu/webapi/rdf/sparql', retrieved: '2026-10-24T09:00:00Z', license: 'CC0-1.0', legal_basis: 'test' };
  const dossiers = parseWorks(json('cellar/works.json') as SparqlResult);
  addActs(dossiers, json('cellar/acts.json') as SparqlResult);
  const facts = (id: string) => cellarFacts(dossiers.get(id)!, ref);

  it('2025/0102(COD): Council documents, COM number and EP report as in Phase A (K3, Cellar part)', () => {
    const e = expected('2025-0102-cod').expected.phase_a;
    const f = facts('2025/0102(COD)');
    const council = f.documents.filter((d) => d.institution === 'council');
    const by = (t: string) => council.filter((d) => d.doc_type === t).length;
    assert.equal(by('ST'), e.council_documents.ST);
    assert.equal(by('WK'), e.council_documents.WK);
    assert.equal(by('CM'), e.council_documents.CM);
    const sorted = [...council].sort((a, b) => `${a.date}`.localeCompare(`${b.date}`));
    assert.equal(`${sorted[0].id} (${sorted[0].date})`, e.council_documents.first);
    assert.equal(`${sorted.at(-1)!.id} (${sorted.at(-1)!.date})`, e.council_documents.last);
    assert.ok(f.identifiers.some((i) => i.alias_type === 'com' && i.alias === e.com));
    assert.ok(f.identifiers.some((i) => i.alias_type === 'ep_register' && i.alias === e.ep_register));
    const r2 = f.identifiers.find((i) => i.alias_type === 'ep_doc' && i.alias === e.ep_doc);
    assert.ok(r2 && r2.provenance.status === 'derived' && r2.provenance.rule === 'R2');
    assert.ok(council.every((d) => d.provenance.status === 'official'), 'R4: dossier assignment is official');
    assert.equal(dossiers.get('2025/0102(COD)')!.fileStatus, e.cellar_file_status);
    assert.equal(dossiers.get('2025/0102(COD)')!.works.length, e.cellar_works);
    assert.deepEqual(f.legal_acts, [], 'no legal act yet');
  });

  it('V9: no EESC or CoR opinion is taken', () => {
    const f = facts('2025/0102(COD)');
    assert.ok(!f.identifiers.some((i) => /52025AE1074|52025IR1935/.test(i.alias)));
    assert.ok(!f.documents.some((d) => /^(EESC|COR)-/.test(d.id)));
  });

  it('R9: produced legal acts with CELEX, ELI and dates', () => {
    const ai = facts('2021/0106(COD)');
    assert.deepEqual(ai.legal_acts.map((a) => a.celex), ['32024R1689']);
    assert.equal(ai.legal_acts[0].eli, 'http://data.europa.eu/eli/reg/2024/1689/oj');
    assert.deepEqual(ai.legal_acts[0].dates.entry_into_force, ['2024-08-01', '2025-02-02', '2025-08-02', '2026-08-02', '2027-08-02']);
    assert.ok(ai.edges.some((e) => e.edge === 'produces' && e.to === '32024R1689' && e.provenance.status === 'official'));
    assert.deepEqual(facts('2025/0359(COD)').legal_acts.map((a) => a.celex), ['32026R1744']);
  });
});

describe('EP procedure object', () => {
  const ref = { source: 'ep_api' as const, url: 'https://data.europarl.europa.eu/api/v2/procedures/2099-0001', retrieved: '2026-10-24T09:00:00Z', license: 'CC-BY-4.0', legal_basis: 'test' };
  it('takes events, trilogues, documents and lead committees, and no persons', () => {
    const p = parseProcedure(fixture('ep/procedure-synthetic.json'), ref);
    assert.equal(p.facts.procedure, '2099/0001(COD)');
    assert.equal(p.facts.steps.length, 5);
    assert.deepEqual(p.facts.steps.filter((s) => s.kind === 'trilogue').map((s) => s.date), ['2099-04-01', '2099-05-01']);
    assert.deepEqual(p.facts.header.ep_committees, ['TEST']);
    assert.equal(p.facts.header.ep_stage, 'RDG1');
    assert.equal(p.latestEvent, '2099-05-01');
    assert.ok(p.facts.identifiers.some((i) => i.alias_type === 'ep_doc' && i.alias === 'A-10-2099-0001'));
    assert.doesNotMatch(JSON.stringify(p.facts), /person|participation/);
    assert.deepEqual(p.unmappedActivityTypes, []);
  });
});

describe('run: simulated source outage changes nothing (K4)', () => {
  const procedure = JSON.parse(fixture('ep/procedure-synthetic.json').toString('utf8'));
  // Use the real Cellar dossier of 2025/0102 for the synthetic EP object, renamed to the same number.
  procedure.data[0].label = '2025/0102(COD)';
  procedure.data[0].id = 'eli/dl/proc/2025-0102';
  for (const e of procedure.data[0].consists_of) e.activity_date = e.activity_date.replace('2099', '2025');
  const epBody = Buffer.from(JSON.stringify(procedure));
  const cellarWorks = fixture('cellar/works.json');
  const cellarActs = fixture('cellar/acts.json');
  const healthy = (): { ep: Transport; cellar: Transport } => ({
    ep: async (req) => (req.url.endsWith('/api/v2/') ? ok(JSON.stringify({ info: { license: { name: 'CC BY 4.0 - Attribution 4.0 International', url: 'https://creativecommons.org/licenses/by/4.0/' }, description: 'Maximum number of requests 500 in 5min.' } })) : ok(epBody)),
    cellar: async (req) => {
      if (req.method === 'GET') return ok('<html><body><p>Article 4 Conditions</p><p>text</p><p>Article 5</p></body></html>', { 'content-type': 'application/xhtml+xml' });
      return ok(decodeURIComponent(req.body ?? '').includes('dossier_produces_resource_legal ?act') ? cellarActs : cellarWorks);
    },
  });
  const down: Transport = async () => status(503);

  it('marks the source unavailable, keeps every stored row and records the outage only in the source health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regesta-k4-'));
    const select = { mode: 'explicit' as const, procedures: ['2025/0102(COD)'] };
    const clock = new ManualClock();
    const h = healthy();
    const first = await runIngestion({ dataDir: dir, select, clock, transports: { ep_api: h.ep, cellar: h.cellar } });
    assert.deepEqual(first.sources.map((s) => [s.source, s.status]), [['ep_feed', 'ok'], ['ep_api', 'ok'], ['cellar', 'ok']]);
    assert.equal(first.licence.length, 3);
    let store = new Store(dir);
    const before = store.procedureDigest('2025/0102(COD)');
    const docs = (store.db.prepare("SELECT doc_type, COUNT(*) AS n FROM documents WHERE procedure = ? AND institution = 'council' GROUP BY doc_type ORDER BY doc_type").all('2025/0102(COD)') as { doc_type: string; n: number }[]).map((r) => `${r.doc_type}=${r.n}`);
    assert.deepEqual(docs, ['CM=18', 'ST=33', 'WK=32']);
    store.close();

    clock.advance(24 * 3600_000);
    const second = await runIngestion({ dataDir: dir, select, clock, transports: { ep_api: down, cellar: down }, licenceEvidence: false });
    assert.deepEqual(second.sources.map((s) => [s.source, s.status]), [['ep_feed', 'unavailable'], ['ep_api', 'unavailable'], ['cellar', 'unavailable']]);
    assert.equal(second.procedures.changed, 0);
    store = new Store(dir);
    assert.equal(store.procedureDigest('2025/0102(COD)'), before, 'no change at the procedure');
    const health = store.db.prepare('SELECT source, status, last_success FROM source_health WHERE run = ? ORDER BY source').all(second.run) as { source: string; status: string; last_success: string }[];
    assert.deepEqual(health.map((r) => [r.source, r.status, r.last_success]), [['cellar', 'unavailable', first.finished], ['ep_api', 'unavailable', first.finished], ['ep_feed', 'unavailable', first.finished]]);
    store.close();
    assert.equal(second.retryAfterViolations, 0);
  });

  it('archives raw responses with SHA-256 and references unchanged ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regesta-raw-'));
    const select = { mode: 'explicit' as const, procedures: ['2025/0102(COD)'] };
    const clock = new ManualClock();
    const h = healthy();
    const a = await runIngestion({ dataDir: dir, select, clock, transports: { ep_api: h.ep, cellar: h.cellar }, licenceEvidence: false });
    clock.advance(3600_000);
    const b = await runIngestion({ dataDir: dir, select, clock, transports: { ep_api: h.ep, cellar: h.cellar }, licenceEvidence: false });
    const store = new Store(dir);
    const rows = store.db.prepare('SELECT run, key, sha256, same_as_run FROM raw_objects ORDER BY run, key').all() as { run: string; key: string; sha256: string; same_as_run: string | null }[];
    assert.ok(rows.filter((r) => r.run === a.run).every((r) => r.same_as_run === null && /^[0-9a-f]{64}$/.test(r.sha256)));
    assert.ok(rows.filter((r) => r.run === b.run).every((r) => r.same_as_run === a.run), 'same checksum -> reference only');
    assert.equal(b.procedures.changed, 0);
    assert.equal(a.checksum, b.checksum);
    store.close();
  });
});

describe('run: resume an aborted run where it stopped', () => {
  it('skips what is done, fetches only the rest, and keeps the throttle across the restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'regesta-resume-'));
    const base = JSON.parse(fixture('ep/procedure-synthetic.json').toString('utf8'));
    const body = (pid: string) => {
      const d = structuredClone(base);
      d.data[0].label = `${pid.replace('-', '/')}(COD)`;
      return Buffer.from(JSON.stringify(d));
    };
    let failSecond = true;
    const calls: string[] = [];
    const ep: Transport = async (req) => {
      calls.push(req.url);
      const m = /procedures\/(\d{4}-\d{4})\?/.exec(req.url);
      if (!m) return ok('{"data":[]}');
      if (m[1] === '2099-0002' && failSecond) return status(503);
      return ok(body(m[1]));
    };
    const cellar: Transport = async () => ok('{"results":{"bindings":[]}}');
    const select = { mode: 'explicit' as const, procedures: ['2099/0001(COD)', '2099/0002(COD)'] };
    const clock = new ManualClock();
    const first = await runIngestion({ dataDir: dir, select, clock, transports: { ep_api: ep, cellar }, licenceEvidence: false });
    assert.equal(first.sources.find((s) => s.source === 'ep_api')!.objectsFailed, 1);
    // Simulate an abort: the run was never finished.
    let store = new Store(dir);
    store.db.prepare('UPDATE runs SET finished = NULL, status = ? WHERE id = ?').run('running', first.run);
    const before = store.fetchLog(first.run).length;
    store.close();
    failSecond = false;
    calls.length = 0;
    const second = await runIngestion({ dataDir: dir, select, clock, transports: { ep_api: ep, cellar }, licenceEvidence: false, resume: first.run });
    assert.equal(second.run, first.run);
    assert.ok(second.resumed);
    assert.deepEqual(calls.filter((u) => /procedures\/\d{4}-\d{4}\?/.test(u)).map((u) => /(\d{4}-\d{4})/.exec(u)![1]), ['2099-0002'], 'only the missing procedure');
    store = new Store(dir);
    const log = store.fetchLog(first.run);
    assert.ok(log.length > before);
    for (let i = 1; i < log.length; i++) if (log[i].source !== 'cellar' && log[i - 1].source !== 'cellar') assert.ok(log[i].started_ms - log[i - 1].started_ms >= 2_000);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM run_items WHERE run = ? AND source = 'ep_api' AND outcome = 'ok'").get(first.run) as { n: number }).n, 2);
    store.close();
    await assert.rejects(runIngestion({ dataDir: dir, select, clock, transports: { ep_api: ep, cellar }, resume: first.run }), /finished/);
  });
});
