// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Polite HTTP client, one instance per source (04-datenquellen.md "Gemeinsame Regeln", 05-architektur.md 2.2):
//   - one request at a time, a minimum interval between request starts and an optional window limit;
//   - Retry-After is always obeyed: no request to the source starts before it has expired;
//   - after a 429 the interval doubles for the rest of the run ("half speed");
//   - three retries with growing waits on 5xx, timeouts and network errors;
//   - 403, a bot challenge or HTTP 202 without content stop the source at once (no workaround);
//   - every attempt is written to the fetch log, which is the evidence for criterion "no request before Retry-After".

import { iso, type Clock } from './clock.ts';

// ep_feed is the procedures feed of the EP API: same host and same client as ep_api, own entry in the source health.
export type SourceId = 'ep_api' | 'ep_feed' | 'cellar';

export interface SourcePolicy {
  source: SourceId;
  minIntervalMs: number;
  window?: { ms: number; max: number };
  timeoutMs: number;
  retryDelaysMs: number[];
}

// Values from 04-datenquellen.md Q1 and Q2.
export const EP_POLICY: SourcePolicy = {
  source: 'ep_api',
  minIntervalMs: 2_000,
  window: { ms: 5 * 60_000, max: 100 },
  timeoutMs: 120_000,
  retryDelaysMs: [30_000, 120_000, 600_000],
};
export const CELLAR_POLICY: SourcePolicy = {
  source: 'cellar',
  minIntervalMs: 1_000,
  timeoutMs: 60_000,
  retryDelaysMs: [30_000, 120_000, 600_000],
};

export const USER_AGENT = 'berth-regesta-prod-0.1.0';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
};

export interface FetchLogEntry {
  source: SourceId;
  url: string;
  attempt: number;
  not_before: string | null; // earliest start allowed by an earlier Retry-After, if one was pending
  started: string;
  finished: string;
  status: number | null; // null: network error or timeout
  error?: string;
  retry_after_s?: number;
  retry_after_ms?: number;
  response_excerpt?: string; // only for error responses (status >= 400): what the source said, for the source health
  started_ms: number;
  finished_ms: number;
  not_before_ms: number | null;
}

export class SourceBlocked extends Error {
  readonly source: SourceId;
  readonly status: number | null;
  constructor(source: SourceId, status: number | null, reason: string) {
    super(`${source}: ${reason}`);
    this.source = source;
    this.status = status;
  }
}
export class FetchFailed extends Error {
  readonly source: SourceId;
  readonly url: string;
  readonly lastStatus: number | null;
  constructor(source: SourceId, url: string, lastStatus: number | null, message: string) {
    super(message);
    this.source = source;
    this.url = url;
    this.lastStatus = lastStatus;
  }
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  attempts: number;
  durationMs: number;
}

// Retry-After is either delta-seconds or an HTTP date (RFC 9110 10.2.3).
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

const CHALLENGE = /captcha|challenge-platform|cf-chl|awswaf|aws-waf-token|bot detection/i;

export class PoliteClient {
  private lastStart: number | null = null;
  private notBefore: number | null = null;
  private starts: number[] = [];
  private interval: number;
  readonly log: FetchLogEntry[] = [];
  readonly policy: SourcePolicy;
  private readonly clock: Clock;
  private readonly transport: Transport;
  private readonly onEntry?: (e: FetchLogEntry) => void;

  // onEntry receives every finished attempt at once, so that the fetch log survives an aborted run.
  constructor(policy: SourcePolicy, clock: Clock, transport: Transport = fetchTransport, onEntry?: (e: FetchLogEntry) => void) {
    this.policy = policy;
    this.clock = clock;
    this.transport = transport;
    this.onEntry = onEntry;
    this.interval = policy.minIntervalMs;
  }

  get currentIntervalMs(): number {
    return this.interval;
  }

  // Resume after an aborted run: restore the throttle state from the stored fetch log of that run,
  // so that interval, window and a pending Retry-After also hold across the restart.
  prime(entries: Pick<FetchLogEntry, 'started_ms' | 'finished_ms' | 'retry_after_ms' | 'status'>[]): void {
    for (const e of entries) {
      this.lastStart = Math.max(this.lastStart ?? 0, e.started_ms);
      this.starts.push(e.started_ms);
      if (e.retry_after_ms !== undefined && e.retry_after_ms !== null) this.notBefore = Math.max(this.notBefore ?? 0, e.finished_ms + e.retry_after_ms);
      if (e.status === 429) this.interval = Math.max(this.interval, this.policy.minIntervalMs * 2);
    }
    this.starts.sort((x, y) => x - y);
  }

  private async waitForSlot(): Promise<number | null> {
    const pending = this.notBefore;
    for (;;) {
      const now = this.clock.now();
      let earliest = now;
      if (this.lastStart !== null) earliest = Math.max(earliest, this.lastStart + this.interval);
      if (this.notBefore !== null) earliest = Math.max(earliest, this.notBefore);
      const w = this.policy.window;
      if (w) {
        this.starts = this.starts.filter((t) => t > now - w.ms);
        if (this.starts.length >= w.max) earliest = Math.max(earliest, this.starts[0] + w.ms);
      }
      if (earliest <= now) return pending;
      await this.clock.sleep(earliest - now);
    }
  }

  async request(url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; as?: SourceId } = {}): Promise<FetchResult> {
    const source = init.as ?? this.policy.source;
    const delays = this.policy.retryDelaysMs;
    let lastStatus: number | null = null;
    let lastError = '';
    const t0 = this.clock.now();
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      const pending = await this.waitForSlot();
      const started = this.clock.now();
      this.lastStart = started;
      this.starts.push(started);
      const entry: FetchLogEntry = {
        source, url, attempt,
        not_before: pending === null ? null : iso(pending), not_before_ms: pending,
        started: iso(started), started_ms: started, finished: '', finished_ms: 0, status: null,
      };
      this.log.push(entry);
      let res: HttpResponse | null = null;
      try {
        res = await this.transport({
          url,
          method: init.method ?? 'GET',
          headers: { 'User-Agent': USER_AGENT, ...init.headers },
          body: init.body,
          timeoutMs: this.policy.timeoutMs,
        });
      } catch (err) {
        lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        entry.error = lastError;
      }
      const finished = this.clock.now();
      entry.finished = iso(finished);
      entry.finished_ms = finished;
      if (this.notBefore !== null && this.notBefore <= started) this.notBefore = null;

      let retryWait = 0;
      if (res) {
        entry.status = res.status;
        lastStatus = res.status;
        if (res.status >= 400) entry.response_excerpt = res.body.subarray(0, 1000).toString('utf8');
        const retryAfter = parseRetryAfter(res.headers['retry-after'], finished);
        if (retryAfter !== null) {
          entry.retry_after_s = Math.ceil(retryAfter / 1000);
          entry.retry_after_ms = retryAfter;
          this.notBefore = Math.max(this.notBefore ?? 0, finished + retryAfter);
        }
      }
      this.onEntry?.(entry);
      if (res) {
        const text = res.body.subarray(0, 4096).toString('utf8');
        if (res.status === 403) throw new SourceBlocked(source, 403, 'HTTP 403 (no workaround, source stopped for this run)');
        if (res.status === 202 && res.body.length === 0)
          throw new SourceBlocked(source, 202, 'HTTP 202 without content (WAF challenge)');
        if ((res.headers['content-type'] ?? '').includes('text/html') && CHALLENGE.test(text))
          throw new SourceBlocked(source, res.status, 'bot challenge page');
        if (res.status === 429) {
          this.interval = Math.max(this.interval, this.policy.minIntervalMs * 2);
          lastError = 'HTTP 429';
        } else if (res.status >= 500) {
          lastError = `HTTP ${res.status}`;
        } else {
          return { status: res.status, headers: res.headers, body: res.body, attempts: attempt, durationMs: finished - t0 };
        }
      }
      if (attempt > delays.length) break;
      retryWait = delays[attempt - 1];
      if (this.notBefore !== null) retryWait = Math.max(retryWait, this.notBefore - this.clock.now());
      await this.clock.sleep(retryWait);
    }
    throw new FetchFailed(source, url, lastStatus, `${source}: ${url} failed after ${delays.length + 1} attempts (${lastError})`);
  }
}

// Evidence check for criterion K2: no request started before a Retry-After of an earlier response
// from the same host expired (ep_api and ep_feed share a host).
export function retryAfterViolations(log: Pick<FetchLogEntry, 'url' | 'started_ms' | 'finished_ms' | 'retry_after_ms'>[]): typeof log {
  const out: typeof log = [];
  const byHost = new Map<string, number>();
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  for (const e of [...log].sort((a, b) => a.started_ms - b.started_ms)) {
    const until = byHost.get(host(e.url));
    if (until !== undefined && e.started_ms < until) out.push(e);
    if (e.retry_after_ms !== undefined && e.retry_after_ms !== null) byHost.set(host(e.url), Math.max(until ?? 0, e.finished_ms + e.retry_after_ms));
  }
  return out;
}
