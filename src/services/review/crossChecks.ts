/**
 * Deterministic cross-document checks: facts that must agree between sections (a dose, a strain name, the project
 * period, the aim list). Measured on a real 25k-token R01, these four caught 4 of 9 planted weaknesses in 18 ms with
 * no false alarms, where no LLM prompting strategy got past 3 (see docs/superpowers/specs/2026-10-10-review-v2-design.md
 * section 3.6). They need the section map, so they live here and not in detectors.ts, which is text-based.
 *
 * Every regex that scans a whole grant uses bounded repetition. A nested quantifier here backtracked for minutes
 * on a 25k-token document.
 */
import type { Section } from './types';
import { deSymbol } from '../../utils/symbolFont';

/** A finding before R2 maps it into its own Finding type. Anchored by section key; `quote` is verbatim text. */
export interface CrossFinding {
  checkId: string;
  sectionKey: string;
  quote: string;
  issue: string;
  recommendation: string;
  severity: 'critical' | 'major' | 'minor';
  source: string;
}

// ── quantity disagreement ───────────────────────────────────────────────────────────────────────────
// A quantity is a number (or number pair/list) plus a unit, described by the words around it. Two quantities
// describing the same thing with different values in different places is a disagreement.

// Units that are unmistakable glued to a number ("5mg", "10%").
const UNITS_TIGHT = '(?:µg|ug|mg|ng|kg|µl|ul|ml|µM|uM|nM|mM|%|Å|nm|µm|um|mm|cm|min|hr|hours|days?|weeks?|months?|years?|fold|animals?|mice|rats?|CRs?|patients?|samples?|replicates?|cells?|plants?)';
// Units that are ambiguous without a space: "3M" is a triple mutant, "3 M" is molar; "6x" vs "6 x".
const UNITS_LOOSE = '(?:M|A|g|l|L|h|x)';
const NUM = '\\d+(?:[.,]\\d+)?';

interface Quantity { key: string; value: string; quote: string; sectionKey: string; title: string }

const STOPSET = new Set(['the', 'a', 'an', 'of', 'in', 'for', 'and', 'or', 'with', 'at', 'to', 'by', 'from', 'on', 'be', 'will', 'are', 'is', 'was', 'were', 'we', 'our', 'this', 'that', 'these', 'those', 'as', 'per', 'each', 'both', 'two', 'three', 'using', 'used', 'use', 'about', 'approximately', 'total', 'number', 'numbers', 'required', 'between', 'into', 'out', 'up', 'all', 'any', 'it', 'its', 'their', 'there', 'then', 'than', 'also', 'have', 'has', 'had', 'been', 'which', 'when', 'while', 'after', 'before', 'during', 'within']);

/** The descriptive key of a quantity: the content words immediately around it, normalised and sorted. */
function keyOf(before: string, after: string, unit: string): string {
  const words = `${before} ${after}`.toLowerCase().match(/[a-zµå]{3,}/g) ?? [];
  const content = words.filter(w => !STOPSET.has(w)).slice(-6);
  const head = content.slice(-3).sort();
  return `${unit.toLowerCase()}|${head.join(' ')}`;
}

function normValue(v: string): string {
  return v.replace(/\s+/g, '').replace(/,/g, '.').replace(/^0+(?=\d)/, '');
}

function quantities(sections: Section[]): Quantity[] {
  const out: Quantity[] = [];
  // a value may be a single number or a pair/list ("1 and 10 µg", "1, 5 and 10 µg")
  // bounded repetition: a lead number plus at most three more joined by a separator. Nested quantifiers here
  // backtrack catastrophically on a 25k-token document.
  const tight = new RegExp(`(${NUM}(?:\\s*(?:,|and|to|–|-)\\s*${NUM}){0,3})\\s*(${UNITS_TIGHT})\\b`, 'gi');
  const loose = new RegExp(`(${NUM}(?:\\s*(?:,|and|to|–|-)\\s*${NUM}){0,3})\\s+(${UNITS_LOOSE})\\b`, 'g');
  for (const s of sections) {
    if (s.kind === 'references') continue;
    for (const sentence of deSymbol(s.text).split(/(?<=[.;])\s+/)) {
      for (const m of [...sentence.matchAll(tight), ...sentence.matchAll(loose)]) {
        const [whole, value, unit] = m;
        const i = m.index ?? 0;
        const before = sentence.slice(Math.max(0, i - 90), i);
        const after = sentence.slice(i + whole.length, i + whole.length + 60);
        out.push({ key: keyOf(before, after, unit), value: normValue(value), quote: sentence.trim().slice(0, 240), sectionKey: s.key, title: s.title });
      }
    }
  }
  return out;
}

/**
 * The same described quantity given with two different values in two places. One finding per site, so the author sees
 * both and the result does not depend on which site the scan met first. Units that are ambiguous glued to a number
 * (M, A, g, l, h, x) need whitespace: "3M" is a triple mutant, "3 M" is molar.
 */
export function quantityDisagreements(sections: Section[]): CrossFinding[] {
  const byKey = new Map<string, Quantity[]>();
  for (const q of quantities(sections)) {
    if (!byKey.has(q.key)) byKey.set(q.key, []);
    byKey.get(q.key)!.push(q);
  }
  const out: CrossFinding[] = [];
  for (const [, group] of byKey) {
    const values = [...new Set(group.map(q => q.value))];
    if (values.length < 2) continue;
    // only report when the SAME description carries different values in different places
    const a = group.find(q => q.value === values[0])!;
    const b = group.find(q => q.value === values[1])!;
    if (a.quote === b.quote) continue;
    for (const [here, there] of [[a, b], [b, a]] as const) {
      out.push({
        checkId: 'g-con-numbers', sectionKey: here.sectionKey, quote: here.quote,
        issue: `This quantity is given as ${here.value} here and as ${there.value} in "${there.title}" ("${there.quote.slice(0, 120)}").`,
        recommendation: 'Make the two agree or say why they differ.',
        severity: 'major', source: 'detector:quantity',
      });
    }
  }
  return out;
}

// ── entity drift ────────────────────────────────────────────────────────────────────────────────────
// A named entity (strain, construct, cell line, antibody) that appears once where a near-identical name
// dominates elsewhere is probably a slip.

const ENTITY = /\b(?:[A-Z][A-Za-z]*\d+[A-Za-z0-9]*|[A-Z]{2,}\d*(?:\.\d+)?|[A-Z][a-z]+\s\d+[A-Z]?)\b/g;
const IGNORE = /^(?:Fig|Figure|Table|Aim|Year|Y\d|Q\d|No|Dr|Prof|PhD|USA|NIH|RNA|DNA|PCR|ELISA|SDS|PAGE|EM|SEM|TEM|PDB|BSL|IRB|IACUC|CO2|H2O)$/i;
/** Two-letter lab shorthand that collides with everything under an edit-distance rule. */
const LAB_ABBREV = /^(?:NS|RT|CT|SD|SE|SEM|PBS|FBS|BSA|WT|KO|OD|IU|ID|IM|IP|IV|SC|PO|MW|PI|CI|HR|TS|LOD|LLOQ)$/i;
/** A figure or table legend names panels (A, B, C2) that are not entities. */
const LEGEND = /^(?:fig|figure|table|panel|supplementary|scheme)\b|\bpanel\b/i;

/**
 * A name used once where a near-identical name dominates elsewhere. Skips figure and table legends, two-letter lab
 * shorthand, numbered variants (F1 against F2) and a common name with a citation number glued on (E170G3). Minor
 * severity: precision was 2 of 8 on real grants, so treat it as a list of names to check.
 */
export function entityDrift(sections: Section[]): CrossFinding[] {
  const counts = new Map<string, { n: number; first: { quote: string; sectionKey: string } }>();
  for (const s of sections) {
    if (s.kind === 'references') continue;
    for (const sentence of deSymbol(s.text).split(/(?<=[.;])\s+/)) {
      if (LEGEND.test(sentence)) continue;
      for (const m of sentence.matchAll(ENTITY)) {
        const name = m[0];
        if (IGNORE.test(name) || LAB_ABBREV.test(name) || name.length < 2) continue;
        const e = counts.get(name);
        if (e) e.n++;
        else counts.set(name, { n: 1, first: { quote: sentence.trim().slice(0, 240), sectionKey: s.key } });
      }
    }
  }
  // a singleton whose name is one edit away from a name used at least 4 times
  const common = [...counts.entries()].filter(([, v]) => v.n >= 4).map(([k]) => k);
  const out: CrossFinding[] = [];
  for (const [name, v] of counts) {
    if (v.n !== 1) continue;
    // "E170G3" is "E170G" with a superscript citation glued on by the extractor, not a second name
    if (common.some(c => name.length > c.length && name.startsWith(c) && /^\d{1,3}$/.test(name.slice(c.length)))) continue;
    const near = common.find(c => c !== name && editDistance(c.toLowerCase(), name.toLowerCase()) <= 1 && Math.abs(c.length - name.length) <= 1);
    if (!near) continue;
    // a one-character difference in an all-digit tail is a different numbered thing (F1 vs F2), not a renaming
    if (/\d$/.test(name) && /\d$/.test(near) && name.slice(0, -1) === near.slice(0, -1)) continue;
    out.push({
      checkId: 'g-con-terms', sectionKey: v.first.sectionKey, quote: v.first.quote,
      issue: `"${name}" appears once; "${near}" is used throughout.`,
      recommendation: 'Check whether this is the same thing under two names.',
      severity: 'minor', source: 'detector:entity',
    });
  }
  return out;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// ── milestone beyond the project period ─────────────────────────────────────────────────────────────
// "Y6Q3" or "year 6" in a five-year project is arithmetic, not judgment.
/** A year or quarter label (Y6Q3, "year 6") beyond the project period. Silent when `projectYears` is unknown. */
export function milestoneOverrun(sections: Section[], projectYears?: number): CrossFinding[] {
  if (!projectYears) return [];
  const out: CrossFinding[] = [];
  const re = /\b(?:Y(\d{1,2})(?:Q[1-4])?|year\s+(\d{1,2})|yr\s*(\d{1,2}))\b/gi;
  for (const s of sections) {
    if (s.kind === 'references') continue;
    for (const sentence of deSymbol(s.text).split(/(?<=[.;])\s+/)) {
      for (const m of sentence.matchAll(re)) {
        const year = Number(m[1] ?? m[2] ?? m[3]);
        if (!Number.isFinite(year) || year <= projectYears || year > 20) continue;
        out.push({
          checkId: 'g-fea-timeline', sectionKey: s.key, quote: sentence.trim().slice(0, 240),
          issue: `This milestone falls in year ${year}, beyond the ${projectYears}-year project period.`,
          recommendation: 'Move it inside the period or say why the work continues past the award.',
          severity: 'major', source: 'detector:timeline',
        });
      }
    }
  }
  return out;
}

// ── aim labels present in one place and not the other ───────────────────────────────────────────────
// A set difference between the Aims page and the Approach, not a judgment call.
const AIM_LABEL = /\b((?:Aim|Sub-aim|Project)\s*\d+[a-z]?|[A-C]\d+(?:\.\d+)?[a-z]?)\b/g;

function labelsIn(sections: Section[], kinds: Set<string>): Map<string, { sectionKey: string; quote: string }> {
  const out = new Map<string, { sectionKey: string; quote: string }>();
  for (const s of sections) {
    if (!kinds.has(s.kind)) continue;
    for (const where of [s.title, ...deSymbol(s.text).split(/(?<=[.;])\s+/)]) {
      for (const m of where.matchAll(AIM_LABEL)) {
        const label = m[1].replace(/\s+/g, ' ').replace(/^Sub-aim/i, 'Aim').trim();
        if (!out.has(label)) out.set(label, { sectionKey: s.key, quote: where.trim().slice(0, 240) });
      }
    }
  }
  return out;
}

/**
 * Set difference between the aim labels on the Aims page and those in the Approach. A label is reported only when a
 * sibling of the same stem appears on the other side, so an unrelated numbering scheme is not flagged.
 */
/** True when a lower-level label on the other side sits under this one ("C2.2" covered by "C2.2a"). */
function coveredByDescendant(label: string, other: Map<string, unknown>): boolean {
  for (const candidate of other.keys()) {
    if (candidate !== label && candidate.startsWith(label) && /^[.\s]?\d*[a-z]?$/i.test(candidate.slice(label.length))) return true;
  }
  return false;
}

/** True when the other side numbers its aims the same way ("Aim 2b" against "Aim 1", not against "C1"). */
function sharesScheme(label: string, other: Map<string, unknown>): boolean {
  const scheme = (x: string) => x.replace(/[\s.\d]+[a-z]?$/i, '').replace(/\d+$/, '') || x[0];
  const mine = scheme(label);
  for (const candidate of other.keys()) if (scheme(candidate) === mine) return true;
  return false;
}

/**
 * A label counts as a gap only when a SIBLING at its own level is listed on the other side. "C2.2e" present only in
 * the Approach is a real gap when C2.2a to C2.2d are on the Aims page; "C1.2a" is not, because no child of C1.2 is
 * itemised there and a proposal need not list every sub-sub-aim. Without this rule a real R01 produced seven
 * findings where one was true (measured 2026-10-11).
 */
function hasListedSibling(label: string, other: Map<string, unknown>): boolean {
  const parent = siblingParent(label);
  if (parent === null) return false;
  for (const candidate of other.keys()) {
    if (candidate !== label && siblingParent(candidate) === parent) return true;
  }
  return false;
}

/** The label one level up: "C2.2e" -> "C2.2", "C2.2" -> "C2", "Aim 2" -> "Aim". Null when there is no level above. */
function siblingParent(label: string): string | null {
  const trimmed = label.replace(/[a-z]$/i, '');
  if (trimmed !== label) return trimmed;
  const dotted = label.replace(/\.\d+$/, '');
  if (dotted !== label) return dotted;
  const numbered = label.replace(/\s*\d+$/, '');
  if (numbered !== label) return numbered;
  const lettered = label.replace(/\d+$/, '');
  return lettered !== label ? lettered : null;
}

export function aimListMismatch(sections: Section[]): CrossFinding[] {
  const aims = labelsIn(sections, new Set(['aims', 'summary']));
  const approach = labelsIn(sections, new Set(['approach', 'strategy']));
  if (!aims.size || !approach.size) return [];
  const out: CrossFinding[] = [];
  for (const [label, where] of approach) {
    if (aims.has(label)) continue;
    if (!hasListedSibling(label, aims)) continue;
    out.push({
      checkId: 'g-log-aims-approach', sectionKey: where.sectionKey, quote: where.quote,
      issue: `${label} appears in the Approach but not on the Specific Aims page.`,
      recommendation: 'Add it to the aims or fold it into an existing aim.',
      severity: 'major', source: 'detector:aim-list',
    });
  }
  for (const [label, where] of aims) {
    if (approach.has(label)) continue;
    // The two directions are not symmetric. A promise on the Aims page that the Approach never delivers is always a
    // gap, so this direction needs no sibling. It needs only to be sure the two sides use the same numbering, or an
    // Aims page numbered "Aim 1, Aim 2" against an Approach numbered "C1, C2" would report every aim as missing.
    if (!sharesScheme(label, approach)) continue;
    // "C2.2" is delivered when the Approach describes C2.2a and C2.2b, even if it never repeats the bare label.
    if (coveredByDescendant(label, approach)) continue;
    out.push({
      checkId: 'g-log-aims-approach', sectionKey: where.sectionKey, quote: where.quote,
      issue: `${label} is promised on the Specific Aims page but the Approach never describes it.`,
      recommendation: 'Describe it in the Approach or remove it from the aims.',
      severity: 'major', source: 'detector:aim-list',
    });
  }
  return out;
}

/** Run all four detectors. `projectYears` enables the milestone check; without it that check stays silent. */
export function crossChecks(sections: Section[], projectYears?: number): CrossFinding[] {
  return [
    ...quantityDisagreements(sections),
    ...entityDrift(sections),
    ...milestoneOverrun(sections, projectYears),
    ...aimListMismatch(sections),
  ];
}
