// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Q1 EP Open Data API v2 (04-datenquellen.md): procedure lists per type and year, one procedure object per call.
// Taken: title, type, stage, events with type and date (trilogue meetings included), EP document ids,
// lead committees (V6: list). Not taken in M1: roles of persons (had_participation of persons; the
// people endpoint follows in M3, build rule G1), speeches, texts. The raw response is archived unchanged.

import { readFileSync } from 'node:fs';
import { epProc, parseProcedureNumber, procSlug, stripPrefix } from './ids.ts';
import type { DocumentRow, IdentifierRow, ProcedureFacts, SourceRef, StepRow } from './store.ts';

export const EP_BASE = 'https://data.europarl.europa.eu/api/v2';
export const EP_LICENSE = 'CC-BY-4.0';
export const EP_LEGAL_BASIS = 'European Parliament Bureau decision of 16.12.2024 on open data, OJ C/2025/341, Art. 4';
export const SCOPE_FROM = '2024-07-16'; // start of the 10th parliamentary term (02-modul-1.md 1)
export const LIST_LIMIT = 50;

export const listUrl = (type: string, year: number, offset: number): string =>
  `${EP_BASE}/procedures?process-type=${type}&year=${year}&format=application%2Fld%2Bjson&offset=${offset}&limit=${LIST_LIMIT}`;
export const feedUrl = (type: string, since: string): string =>
  `${EP_BASE}/procedures/feed?process-type=${type}&timeframe=custom&start-date=${since}&format=application%2Fld%2Bjson`;
export const procedureUrl = (processId: string): string => `${EP_BASE}/procedures/${processId}?format=application%2Fld%2Bjson`;

export interface ListPage { ids: { processId: string; label: string; type: string }[]; total: number }

export function parseList(body: Buffer): ListPage {
  const d = JSON.parse(body.toString('utf8')) as { data?: { process_id?: string; label?: string; process_type?: string }[]; meta?: { total?: number } };
  return {
    ids: (d.data ?? []).filter((x) => x.process_id && x.label).map((x) => ({ processId: x.process_id!, label: x.label!, type: x.process_type ?? '' })),
    total: d.meta?.total ?? 0,
  };
}

// EP activity type -> step kind, from the published schema (step-kind.schema.json, x-ep-activity-types).
let activityMap: Record<string, string> | null = null;
export function activityKinds(): Record<string, string> {
  if (!activityMap) {
    const s = JSON.parse(readFileSync(new URL('../../schema/v0.1/step-kind.schema.json', import.meta.url), 'utf8')) as { 'x-ep-activity-types': Record<string, string> };
    activityMap = s['x-ep-activity-types'];
  }
  return activityMap;
}

type Node = Record<string, unknown>;
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
const str = (x: unknown): string | undefined => {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Node;
    if (typeof o.en === 'string') return o.en;
    if (typeof o['@value'] === 'string') return o['@value'] as string;
    if (typeof o.id === 'string') return o.id;
  }
  return undefined;
};
const last = (uri: string | undefined): string | undefined => uri?.split('/').pop();
const day = (x: unknown): string | null => {
  const s = str(x);
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
  return m ? m[1] : null;
};
const docId = (x: unknown): string | null => {
  const s = str(x);
  return s && s.includes('eli/dl/doc/') ? stripPrefix(s.slice(s.indexOf('eli/dl/doc/')), 'eli/dl/doc/') : null;
};

export interface EpParse {
  facts: ProcedureFacts;
  latestEvent: string | null;
  unmappedActivityTypes: string[];
}

export function parseProcedure(body: Buffer, ref: SourceRef): EpParse {
  const d = JSON.parse(body.toString('utf8')) as { data?: Node[] };
  const p = (d.data ?? [])[0];
  if (!p) throw new Error('EP procedure response without data');
  const label = str(p.label);
  const type = last(str(p.process_type)) ?? '';
  const n = label ? parseProcedureNumber(label) : null;
  if (!n) throw new Error(`EP procedure without a valid label: ${label}`);
  const id = epProc(n);
  const src = [ref];
  const official = { status: 'official' as const };
  const kinds = activityKinds();
  const unmapped = new Set<string>();

  const identifiers: IdentifierRow[] = [
    { alias_type: 'ep_proc', alias: id, provenance: official, sources: src, license: EP_LICENSE },
    { alias_type: 'ep_proc_id', alias: `${n.year}-${n.number}`, provenance: { status: 'derived', rule: 'R1', rule_version: '1.0', quality: 'exact', evidence: [`process_id=${n.year}-${n.number}`, `process_type=${type}`] }, sources: src, license: EP_LICENSE },
  ];
  const steps: StepRow[] = [];
  const documents = new Map<string, DocumentRow>();
  const addDoc = (docRef: string, date: string | null) => {
    if (documents.has(docRef)) return;
    documents.set(docRef, { id: docRef, institution: 'parliament', doc_type: docRef.split('-').slice(0, docRef.match(/^[A-Z]+-\d+-\d{4}-\d{4}$/) ? 1 : 2).join('-'), date, url: `${EP_BASE}/documents/${docRef}`, access: 'public', provenance: official, sources: src, license: EP_LICENSE });
  };

  let latest: string | null = null;
  for (const e of arr(p.consists_of) as Node[]) {
    const eventUri = str(e.id) ?? '';
    const eventId = stripPrefix(eventUri.slice(Math.max(0, eventUri.indexOf('eli/dl/event/'))), 'eli/dl/event/');
    const activity = last(str(e.had_activity_type)) ?? '';
    const date = day(e.activity_date);
    const kind = kinds[activity];
    if (!kind) unmapped.add(activity);
    const refs: string[] = [];
    // Document links of an event as seen in the API on 2026-10-24 (2025/0102: based_on 13, decided_on 4, recorded_in 3 events).
    for (const key of ['based_on_a_realization_of', 'decided_on_a_realization_of', 'recorded_in_a_realization_of']) {
      for (const x of arr(e[key])) {
        const dref = docId(x);
        if (dref) {
          refs.push(dref);
          addDoc(dref, date);
        }
      }
    }
    if (date && (!latest || date > latest)) latest = date;
    steps.push({ id: eventId, institution: 'parliament', kind: kind ?? activity.toLowerCase(), source_kind: activity, date, date_precision: date ? 'day' : null, refs, provenance: official, sources: [{ ...ref, ref: `eli/dl/event/${eventId}` }], license: EP_LICENSE });
    identifiers.push({ alias_type: 'ep_event', alias: eventId, provenance: official, sources: src, license: EP_LICENSE });
  }
  for (const x of arr(p.created_a_realization_of)) {
    const dref = docId(x);
    if (dref) addDoc(dref, null);
  }
  for (const doc of documents.values()) identifiers.push({ alias_type: 'ep_doc', alias: doc.id, provenance: official, sources: src, license: EP_LICENSE });

  // V6: all lead committees. Only participations of organisations are read; participations of persons are skipped.
  const committees = new Set<string>();
  for (const part of arr(p.had_participation) as Node[]) {
    const role = last(str(part.participation_role));
    if (role !== 'COMMITTEE_LEAD') continue;
    for (const org of arr(part.had_participant_organization)) {
      const code = last(str(org));
      if (code && /^[A-Z][A-Z0-9]{3}$/.test(code)) committees.add(code);
    }
  }

  return {
    facts: {
      procedure: id,
      source: 'ep_api',
      header: {
        type,
        slug: procSlug(n),
        title: str(p.process_title) ?? undefined,
        ep_stage: last(str(p.current_stage)) ?? undefined,
        ep_committees: [...committees].sort(),
        latest_ep_event: latest ?? undefined,
      },
      identifiers,
      steps,
      documents: [...documents.values()],
      edges: [],
      legal_acts: [],
      gaps: [],
    },
    latestEvent: latest,
    unmappedActivityTypes: [...unmapped].filter(Boolean).sort(),
  };
}

export const inScope = (latestEvent: string | null): boolean => latestEvent !== null && latestEvent >= SCOPE_FROM;
