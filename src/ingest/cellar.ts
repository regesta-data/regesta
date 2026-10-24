// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Q2 Cellar (04-datenquellen.md): dossier works and produced legal acts, bundled up to 50 dossiers per query.
// Rules applied here:
//   R1  Cellar procedure number 'YYYY/NNNN/TYPE' -> canonical 'YYYY/NNNN(TYPE)'
//   R2  EP register notation in the dossier ('ep:P10_A(2025)0272') -> EP document id ('A-10-2025-0272')
//   R4  Council document in the dossier -> procedure (official)
//   R9  legal act produced by the dossier -> procedure (official)
// Not taken (V9, decision 21.10.2026): opinions of the EESC and the CoR. Not taken (04-datenquellen.md):
// full texts, summaries, consolidated versions.

import { cellarProc, councilDocType, normaliseCommissionDoc, normaliseCouncilDoc, parseProcedureNumber, registerToEpDoc, epProc, expandEli } from './ids.ts';
import type { DocumentRow, EdgeRow, IdentifierRow, LegalActRow, ProcedureFacts, SourceRef, StepRow } from './store.ts';

export const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';
export const CELLAR_LICENSE = 'CC0-1.0';
export const CELLAR_LEGAL_BASIS = 'EUR-Lex legal notice (metadata CC0 1.0); Commission Decision 2011/833/EU, Art. 4; Decision C(2019) 1655, Art. 2';
export const COUNCIL_LICENSE = 'LicenseRef-Council-Decision-2017-1842';
export const BATCH = 50;

const XSD_STRING = '<http://www.w3.org/2001/XMLSchema#string>';
const RES = 'http://publications.europa.eu/resource/';

const values = (procs: string[]): string =>
  procs.map((p) => {
    const n = parseProcedureNumber(p);
    if (!n) throw new Error(`not a procedure number: ${p}`);
    return `"${cellarProc(n)}"^^${XSD_STRING}`;
  }).join(' ');

export function worksQuery(procs: string[]): string {
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?ref ?status ?work (GROUP_CONCAT(DISTINCT STR(?id); separator="|") AS ?ids) (SAMPLE(?date) AS ?date) WHERE {
  VALUES ?ref { ${values(procs)} }
  ?dossier cdm:procedure_code_interinstitutional_reference_procedure ?ref .
  OPTIONAL { ?dossier cdm:procedure_code_interinstitutional_has_status_file-status ?status }
  OPTIONAL { ?dossier cdm:dossier_contains_work ?work .
             OPTIONAL { ?work owl:sameAs ?id }
             OPTIONAL { ?work cdm:work_date_document ?date } }
} GROUP BY ?ref ?status ?work`;
}

export function actsQuery(procs: string[]): string {
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT ?ref ?act ?p ?o WHERE {
  VALUES ?ref { ${values(procs)} }
  ?dossier cdm:procedure_code_interinstitutional_reference_procedure ?ref ;
           cdm:dossier_produces_resource_legal ?act .
  ?act ?p ?o .
  FILTER(?p IN (owl:sameAs, cdm:resource_legal_id_celex, cdm:resource_legal_eli, cdm:work_date_document,
                cdm:resource_legal_date_entry-into-force, cdm:resource_legal_date_deadline,
                cdm:resource_legal_date_transposition, cdm:resource_legal_date_end-of-validity))
}`;
}

interface Binding { [k: string]: { value: string } | undefined }
export interface SparqlResult { results: { bindings: Binding[] } }

const v = (b: Binding, k: string): string | undefined => b[k]?.value;

export interface CellarDossier {
  procedure: string; // canonical
  fileStatus: string | null;
  works: { work: string; ids: string[]; date: string | null }[];
  acts: Map<string, Map<string, Set<string>>>; // act uri -> predicate -> values
}

export function parseWorks(res: SparqlResult): Map<string, CellarDossier> {
  const out = new Map<string, CellarDossier>();
  for (const b of res.results.bindings) {
    const proc = parseProcedureNumber(v(b, 'ref') ?? '');
    if (!proc) continue;
    const id = epProc(proc);
    let d = out.get(id);
    if (!d) out.set(id, (d = { procedure: id, fileStatus: null, works: [], acts: new Map() }));
    const status = v(b, 'status');
    if (status) d.fileStatus = status.split('/').pop() ?? null;
    const work = v(b, 'work');
    if (work) d.works.push({ work, ids: (v(b, 'ids') ?? '').split('|').filter(Boolean).map((x) => decodeURIComponent(x.replace(RES, ''))), date: v(b, 'date') ?? null });
  }
  return out;
}

export function addActs(dossiers: Map<string, CellarDossier>, res: SparqlResult): void {
  for (const b of res.results.bindings) {
    const proc = parseProcedureNumber(v(b, 'ref') ?? '');
    const act = v(b, 'act');
    const p = v(b, 'p');
    const o = v(b, 'o');
    if (!proc || !act || !p || !o) continue;
    const d = dossiers.get(epProc(proc));
    if (!d) continue;
    let m = d.acts.get(act);
    if (!m) d.acts.set(act, (m = new Map()));
    const key = p.split(/[#/]/).pop() ?? p;
    if (!m.has(key)) m.set(key, new Set());
    m.get(key)!.add(o.startsWith(RES) ? decodeURIComponent(o.slice(RES.length)) : o);
  }
}

export type WorkKind = 'council' | 'ep' | 'commission' | 'eesc_cor' | 'ep_position' | 'other';

export function classifyWork(ids: string[]): WorkKind {
  if (ids.some((i) => i.startsWith('consil/'))) return 'council';
  if (ids.some((i) => i.startsWith('eesc/') || i.startsWith('cor/'))) return 'eesc_cor';
  if (ids.some((i) => i.startsWith('comnat/') || /^immc\/(COM|SEC|SWD|C)\(/.test(i))) return 'commission';
  if (ids.some((i) => i.startsWith('ep/'))) return 'ep';
  if (ids.some((i) => /^celex\/5\d{4}AP\d+/.test(i))) return 'ep_position';
  return 'other';
}

const DATE_KEYS: Record<string, string> = {
  'resource_legal_date_entry-into-force': 'entry_into_force',
  resource_legal_date_deadline: 'deadline',
  resource_legal_date_transposition: 'transposition',
  'resource_legal_date_end-of-validity': 'end_of_validity',
  work_date_document: 'document',
};

export function cellarFacts(d: CellarDossier, ref: SourceRef): ProcedureFacts {
  const official = { status: 'official' as const };
  const src = [ref];
  const council: SourceRef[] = [{ ...ref, license: COUNCIL_LICENSE, legal_basis: 'Council Decision (EU) 2017/1842, Art. 4 and 6 (identifier and date only), via the Cellar dossier' }];
  const n = parseProcedureNumber(d.procedure)!;
  const identifiers: IdentifierRow[] = [
    { alias_type: 'cellar_proc', alias: cellarProc(n), provenance: { status: 'derived', rule: 'R1', rule_version: '1.0', quality: 'exact', evidence: [`cellar_reference=${cellarProc(n)}`] }, sources: src, license: CELLAR_LICENSE },
  ];
  const documents: DocumentRow[] = [];
  const steps: StepRow[] = [];
  const edges: EdgeRow[] = [];
  const legal_acts: LegalActRow[] = [];
  const seenDocs = new Set<string>();

  for (const w of d.works) {
    const kind = classifyWork(w.ids);
    if (kind === 'eesc_cor') continue; // V9
    if (kind === 'council') {
      const raw = w.ids.find((i) => i.startsWith('consil/'))!;
      const id = normaliseCouncilDoc(raw);
      if (!id) {
        // Outside the published council_doc pattern: kept under the Cellar notation, no alias row.
        const cid = raw.replace('consil/', '');
        if (!seenDocs.has(cid)) documents.push({ id: cid, institution: 'council', doc_type: councilDocType(cid), date: w.date, url: null, access: 'public', provenance: official, sources: council, license: COUNCIL_LICENSE });
        seenDocs.add(cid);
        continue;
      }
      if (seenDocs.has(id)) continue;
      seenDocs.add(id);
      // R4: the dossier assignment is official. Access (public / limite) comes from the PDF header in M2 (Q5, R5).
      documents.push({ id, institution: 'council', doc_type: councilDocType(id), date: w.date, url: null, access: 'public', provenance: official, sources: council, license: COUNCIL_LICENSE });
      identifiers.push({ alias_type: 'council_doc', alias: id, provenance: official, sources: council, license: COUNCIL_LICENSE });
      steps.push({ id: `council-${id.replace(/[ /]/g, '-')}`, institution: 'council', kind: 'council_document', date: w.date, date_precision: w.date ? 'day' : null, refs: [id], provenance: official, sources: council, license: COUNCIL_LICENSE });
      continue;
    }
    if (kind === 'commission') {
      const celex = w.ids.find((i) => i.startsWith('celex/'))?.slice(6);
      const docs = w.ids.filter((i) => i.startsWith('immc/')).map((i) => normaliseCommissionDoc(i.slice(5))).filter((x) => x !== null);
      for (const c of docs) {
        if (seenDocs.has(c.id)) continue;
        seenDocs.add(c.id);
        documents.push({ id: c.id, institution: 'commission', doc_type: c.type.toUpperCase().replace('C_CODE', 'C'), date: w.date, url: celex ? `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}` : null, access: 'public', provenance: official, sources: src, license: CELLAR_LICENSE });
        identifiers.push({ alias_type: c.type, alias: c.id, provenance: official, sources: src, license: CELLAR_LICENSE });
        if (c.type === 'com') steps.push({ id: `commission-${c.id}`, institution: 'commission', kind: 'proposal_adopted', date: w.date, date_precision: w.date ? 'day' : null, refs: [c.id], provenance: official, sources: src, license: CELLAR_LICENSE });
      }
      if (celex) identifiers.push({ alias_type: 'celex', alias: celex, provenance: official, sources: src, license: CELLAR_LICENSE });
      continue;
    }
    if (kind === 'ep' || kind === 'ep_position') {
      for (const i of w.ids) {
        if (i.startsWith('ep/')) {
          const notation = i.slice(3);
          if (!/^(P\d+|[A-Z][A-Z0-9]{3})_[A-Z]+\(\d{4}\)\d+$/.test(notation)) continue; // amendments, agendas, minutes: not identifiers of the schema
          identifiers.push({ alias_type: 'ep_register', alias: notation, provenance: official, sources: src, license: CELLAR_LICENSE });
          const epDoc = registerToEpDoc(notation);
          // R2: register notation -> EP document id, exact by format (alias table, 03-datenmodell.md 2.2).
          if (epDoc) identifiers.push({ alias_type: 'ep_doc', alias: epDoc, provenance: { status: 'derived', rule: 'R2', rule_version: '1.0', quality: 'exact', evidence: [`ep_register=${notation}`] }, sources: src, license: 'CC-BY-4.0' });
        } else if (i.startsWith('celex/')) {
          identifiers.push({ alias_type: 'celex', alias: i.slice(6), provenance: official, sources: src, license: CELLAR_LICENSE });
        } else if (i.startsWith('eli/')) {
          identifiers.push({ alias_type: 'eli', alias: expandEli(`eli:${i.slice(4)}`), provenance: official, sources: src, license: CELLAR_LICENSE });
        }
      }
    }
  }

  // R9: legal acts produced by the dossier.
  for (const [, m] of d.acts) {
    const celex = [...(m.get('resource_legal_id_celex') ?? [])][0] ?? [...(m.get('sameAs') ?? [])].find((x) => x.startsWith('celex/'))?.slice(6);
    if (!celex) continue;
    const eli = [...(m.get('resource_legal_eli') ?? [])][0] ?? null;
    const oj = [...(m.get('sameAs') ?? [])].find((x) => x.startsWith('oj/'))?.slice(3) ?? null;
    const dates: Record<string, string[]> = {};
    for (const [k, name] of Object.entries(DATE_KEYS)) if (m.has(k)) dates[name] = [...m.get(k)!].sort();
    legal_acts.push({ celex, eli, oj_ref: oj, dates, sources: src, license: CELLAR_LICENSE });
    identifiers.push({ alias_type: 'celex', alias: celex, provenance: official, sources: src, license: CELLAR_LICENSE });
    if (eli) identifiers.push({ alias_type: 'eli', alias: eli, provenance: official, sources: src, license: CELLAR_LICENSE });
    edges.push({ edge: 'produces', from: d.procedure, to: celex, provenance: official, sources: src, license: CELLAR_LICENSE });
  }

  const dedupe = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
  return {
    procedure: d.procedure,
    source: 'cellar',
    header: { cellar_file_status: d.fileStatus ?? undefined },
    identifiers: dedupe(identifiers, (x) => `${x.alias_type}|${x.alias}`),
    steps,
    documents,
    edges: dedupe(edges, (x) => `${x.edge}|${x.from}|${x.to}`),
    legal_acts,
    gaps: [],
  };
}
