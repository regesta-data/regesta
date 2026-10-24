// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Manuel Wechner (Berth)

// Identifier normalisation (schema/v0.1/identifier.schema.json, x-normalisation) and the rules
// R1 (procedure number in three spellings) and R2 (EP register notation <-> EP document id).

export type ProcType = 'COD' | 'DEA' | 'RPS';

const EP_PROC = /^(\d{4})\/(\d{4})\(([A-Z]{3})\)$/;
const CELLAR_PROC = /^(\d{4})\/(\d{4})\/([A-Z]{3})$/;
const COUNCIL_PROC = /^(\d{4})\/(\d{4}) \(([A-Z]{3})\)$/;
const EP_PROC_ID = /^(?:eli\/dl\/proc\/)?(\d{4})-(\d{4})$/;

export interface ProcNumber {
  year: string;
  number: string;
  type: string;
}

// R1: the EP spelling 'YYYY/NNNN(TYPE)' is canonical; Cellar 'YYYY/NNNN/TYPE' and Council 'YYYY/NNNN (TYPE)' map to it.
// 'YYYY-NNNN' (EP process_id, ELI-DL) carries no type; the type comes from the EP procedure.
export function parseProcedureNumber(value: string, typeForProcessId?: string): ProcNumber | null {
  const v = value.trim();
  for (const re of [EP_PROC, CELLAR_PROC, COUNCIL_PROC]) {
    const m = re.exec(v);
    if (m) return { year: m[1], number: m[2], type: m[3] };
  }
  const m = EP_PROC_ID.exec(v);
  if (m && typeForProcessId) return { year: m[1], number: m[2], type: typeForProcessId };
  return null;
}

export const epProc = (p: ProcNumber): string => `${p.year}/${p.number}(${p.type})`;
export const cellarProc = (p: ProcNumber): string => `${p.year}/${p.number}/${p.type}`;
export const processId = (p: ProcNumber): string => `${p.year}-${p.number}`;
export const procSlug = (p: ProcNumber): string => `${p.year}-${p.number}-${p.type.toLowerCase()}`;

export function canonicalProcedure(value: string, typeForProcessId?: string): string | null {
  const p = parseProcedureNumber(value, typeForProcessId);
  return p ? epProc(p) : null;
}

// COM, SEC, SWD, C: remove 'immc:', 'final', spaces and leading zeros of the number.
export function normaliseCommissionDoc(value: string): { type: 'com' | 'sec' | 'swd' | 'c_code'; id: string } | null {
  const v = value.replace(/^immc:/, '').replace(/\s+final\b.*$/i, '').replace(/\s+/g, '');
  const m = /^(COM|SEC|SWD|C)\((\d{4})\)0*([1-9]\d*)$/.exec(v);
  if (!m) return null;
  const type = m[1] === 'C' ? 'c_code' : (m[1].toLowerCase() as 'com' | 'sec' | 'swd');
  return { type, id: `${m[1]}(${m[2]})${m[3]}` };
}

// Council documents from Cellar: 'consil/ST_10915_2026_REV_2' -> 'ST 10915/2/26 REV 2',
// 'WK_10372_2025_ADD_1' -> 'WK 10372/25 ADD 1', 'ST_6872_2025_INIT' -> 'ST 6872/25', 'PE_24_2024_REV_1' -> 'PE-CONS 24/1/24 REV 1'.
// Forms outside the published pattern (e.g. a REV of a COR, EXT, DCL) return null; the document is kept
// under its Cellar notation, without an alias.
export function normaliseCouncilDoc(value: string): string | null {
  const v = decodeURIComponent(value).replace(/^(?:consil[:/]|.*\/resource\/consil\/)/, '');
  const m = /^(ST|WK|CM|PE)_(\d+)_(\d{4})((?:_(?:INIT|REV_\d+|ADD_\d+|COR_\d+|EXT_\d+|DCL_\d+))*)$/.exec(v);
  if (!m) return null;
  const [, rawType, num, year, rest] = m;
  const type = rawType === 'PE' ? 'PE-CONS' : rawType;
  const parts = rest.split('_').filter(Boolean);
  let rev: string | null = null;
  let add: string | null = null;
  let cor: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === 'INIT') continue;
    const n = parts[++i];
    if (part === 'REV' && rev === null && cor === null) rev = n; // a REV of an ADD is written 'NNNN/r/YY REV r ADD a'
    else if (part === 'ADD' && add === null && cor === null) add = n;
    else if (part === 'COR' && cor === null) cor = n;
    else return null; // EXT, DCL or an order the published pattern does not cover
  }
  const yy = year.slice(2);
  let out = rev ? `${type} ${num}/${rev}/${yy} REV ${rev}` : `${type} ${num}/${yy}`;
  if (add) out += ` ADD ${add}`;
  if (cor) out += ` COR ${cor}`;
  return out;
}

export const councilDocType = (id: string): string => {
  const t = id.replace(/^consil\//, '').split(/[ _]/)[0];
  return t === 'PE' ? 'PE-CONS' : t;
};

// R2: EP register notation <-> EP document id.
//   P10_A(2025)0272  <-> A-10-2025-0272     (plenary documents: term in the prefix)
//   P10_TA(2026)0001 <-> TA-10-2026-0001
//   SANT_PR(2025)775742 <-> SANT-PR-775742  (committee documents: no term, number is unique)
export function registerToEpDoc(notation: string): string | null {
  const v = decodeURIComponent(notation).replace(/^ep:/, '');
  let m = /^P(\d+)_([A-Z]+)\((\d{4})\)(\d{4})$/.exec(v);
  if (m) return `${m[2]}-${m[1]}-${m[3]}-${m[4]}`;
  m = /^([A-Z][A-Z0-9]{3})_([A-Z]{2})\((\d{4})\)(\d+)$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[4]}`;
  return null;
}

export function epDocToRegister(epDoc: string, year?: string): string | null {
  let m = /^([A-Z]+)-(\d+)-(\d{4})-(\d{4})$/.exec(epDoc);
  if (m) return `P${m[2]}_${m[1]}(${m[3]})${m[4]}`;
  m = /^([A-Z][A-Z0-9]{3})-([A-Z]{2})-(\d+)$/.exec(epDoc);
  if (m && year) return `${m[1]}_${m[2]}(${year})${m[3]}`;
  return null;
}

export const stripPrefix = (value: string, prefix: string): string => (value.startsWith(prefix) ? value.slice(prefix.length) : value);

export function expandEli(value: string): string {
  return value.startsWith('eli:') ? `http://data.europa.eu/eli/${value.slice(4)}` : value;
}
