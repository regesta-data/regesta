// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Licence and terms of each source in their wording, fetched in every run (URL and retrieval time),
// so that every run can show under which terms it took the data (04-datenquellen.md, Auflage 3).
//   EP API: licence field and request limit of its OpenAPI description; Art. 4 of the Bureau decision
//           (OJ C/2025/341, CELEX 32025D00341), fetched from Cellar.
//   Cellar: Art. 4 of Commission Decision 2011/833/EU (CELEX 32011D0833), fetched from Cellar.
// The EUR-Lex legal notice (CC0 for metadata) answers automated requests with HTTP 202 without content
// (WAF challenge, 2026-10-24); it is not fetched (no workaround), the run records it as not reachable.

import { iso, type Clock } from './clock.ts';
import { EP_BASE } from './ep.ts';
import type { PoliteClient, SourceId } from './http.ts';

export interface LicenceEvidence {
  source: SourceId;
  url: string;
  retrieved: string;
  wording: string;
}

export const CELLAR_RESOURCE = 'http://publications.europa.eu/resource/celex/';
export const EURLEX_LEGAL_NOTICE = 'https://eur-lex.europa.eu/content/legal-notice/legal-notice.html';

export function textOf(xhtml: string): string {
  return xhtml
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// The article from its heading up to the next article heading.
export function article(text: string, n: number): string | null {
  const start = text.search(new RegExp(`Article ${n}(?!\\d)`));
  if (start < 0) return null;
  const rest = text.slice(start);
  const next = rest.slice(1).search(new RegExp(`Article ${n + 1}(?!\\d)`));
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
}

export async function fetchLicenceEvidence(ep: PoliteClient, cellar: PoliteClient, clock: Clock): Promise<{ evidence: LicenceEvidence[]; notReachable: string[] }> {
  const evidence: LicenceEvidence[] = [];
  const notReachable: string[] = [];

  const oaUrl = `${EP_BASE}/`;
  try {
    const res = await ep.request(oaUrl, { headers: { Accept: 'application/json' } });
    const oa = JSON.parse(res.body.toString('utf8')) as { info?: { license?: { name?: string; url?: string }; description?: string } };
    const limit = /Maximum number of requests[^<.]*\./.exec(oa.info?.description ?? '')?.[0];
    evidence.push({ source: 'ep_api', url: oaUrl, retrieved: iso(clock.now()), wording: `info.license: "${oa.info?.license?.name}" <${oa.info?.license?.url}>; info.description: "${limit ?? '(no request limit stated)'}"` });
  } catch (err) {
    notReachable.push(`${oaUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const [source, celex, art] of [['ep_api', '32025D00341', 4], ['cellar', '32011D0833', 4]] as const) {
    const url = `${CELLAR_RESOURCE}${celex}`;
    try {
      const res = await cellar.request(url, { headers: { Accept: 'application/xhtml+xml', 'Accept-Language': 'eng' } });
      const wording = res.status === 200 ? article(textOf(res.body.toString('utf8')), art) : null;
      if (wording) evidence.push({ source, url, retrieved: iso(clock.now()), wording: `CELEX ${celex}, ${wording}` });
      else notReachable.push(`${url}: HTTP ${res.status}, Article ${art} not found`);
    } catch (err) {
      notReachable.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  notReachable.push(`${EURLEX_LEGAL_NOTICE}: not fetched, answers automated requests with HTTP 202 without content (WAF challenge, checked 2026-10-24)`);
  return { evidence, notReachable };
}
