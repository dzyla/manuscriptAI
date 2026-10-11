/**
 * Pure scoring for the review eval. Findings from any system (the current pipeline or Review v2) are first turned
 * into NormalizedFinding; matching rules are documented on Expectation (fixtures/types.ts).
 */
import { findTextSpan, normalizeForMatch } from '../../../src/utils/textMatch';
import type { Section } from '../../../src/services/review/types';
import type { Suggestion } from '../../../src/types';
import type { Expectation, ReviewFixture } from './fixtures/types';

export interface NormalizedFinding {
  checkId?: string;
  sectionTitle?: string;
  quote?: string;
  /** Everything the finding says: issue, explanation, recommendation. */
  text: string;
  /** Which agent or system produced it, for the report. */
  source: string;
}

export interface ScoreResult {
  planted: number;
  hit: string[];
  missed: string[];
  falseAlarms: { trapId: string; finding: NormalizedFinding }[];
  total: number;
  /** Findings that hit no planted weakness and no trap: neither confirmed nor refuted. */
  unmatched: number;
}

const MIN_WORD_RUN = 5;
/**
 * Containment is rejected only when the contained (shorter) string is GENERIC: one alphabetic token shorter than
 * this. Anything else is specific enough to locate a finding - a compound ("receptor-bound HN"), a label carrying
 * digits ("Y6Q3 Go/No-Go"), or any multi-word phrase. Thresholds on word count or character length alone kept
 * rejecting correct findings on real grants (measured 2026-10-11): what matters is distinctiveness, not size.
 */
const GENERIC_TOKEN_CHARS = 8;

function norm(s: string): string {
  return normalizeForMatch(s).text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function longestWordRun(a: string[], b: string[]): number {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

export function quotesOverlap(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  const tokens = shorter.split(' ');
  const generic = tokens.length === 1 && /^[a-z]+$/.test(tokens[0]) && tokens[0].length < GENERIC_TOKEN_CHARS;
  if (!generic && longer.includes(shorter)) return true;
  return longestWordRun(na.split(' '), nb.split(' ')) >= MIN_WORD_RUN;
}

function onTopic(e: Expectation, f: NormalizedFinding): boolean {
  return (f.checkId !== undefined && f.checkId === e.checkId) || e.keywords.test(f.text);
}

function quoteHit(e: Expectation, f: NormalizedFinding): boolean {
  return !!f.quote && (e.quoteHints ?? []).some(h => quotesOverlap(f.quote!, h));
}

function locationHit(e: Expectation, f: NormalizedFinding): boolean {
  const hints = e.quoteHints ?? [];
  const inPrimary = f.sectionTitle !== undefined && e.sectionTitles.includes(f.sectionTitle);
  if (inPrimary && (!f.quote || hints.length === 0)) return true;
  const also = e.alsoIn?.find(a => a.sectionTitle === f.sectionTitle);
  return !!also && also.mention.test(`${f.text} ${f.quote ?? ''}`);
}

/** True when the finding is on topic and located for this expectation (any tier). */
export function matches(e: Expectation, f: NormalizedFinding): boolean {
  return onTopic(e, f) && (quoteHit(e, f) || locationHit(e, f));
}

export interface Assignment { expectation: Expectation; kind: 'planted' | 'trap' }

/**
 * Assign a finding to at most one expectation. Tiers, in order, first planted then traps: checkId equal + quote
 * overlap, checkId equal + location, keyword-only + quote overlap, keyword-only + location. Within a tier, fixture order.
 */
export function assign(fx: ReviewFixture, f: NormalizedFinding): Assignment | null {
  const byId = (e: Expectation) => f.checkId !== undefined && f.checkId === e.checkId;
  const byKeyword = (e: Expectation) => e.keywords.test(f.text);
  const tiers: [(e: Expectation) => boolean, (e: Expectation, f: NormalizedFinding) => boolean][] = [
    [byId, quoteHit], [byId, locationHit], [byKeyword, quoteHit], [byKeyword, locationHit],
  ];
  for (const [list, kind] of [[fx.planted, 'planted'], [fx.traps, 'trap']] as const) {
    for (const [topic, hit] of tiers) {
      const found = list.find(e => topic(e) && hit(e, f));
      if (found) return { expectation: found, kind };
    }
  }
  return null;
}

export function scoreFindings(fx: ReviewFixture, findings: NormalizedFinding[]): ScoreResult {
  const hit = new Set<string>();
  const falseAlarms: ScoreResult['falseAlarms'] = [];
  let unmatched = 0;
  for (const f of findings) {
    const a = assign(fx, f);
    if (!a) unmatched++;
    else if (a.kind === 'planted') hit.add(a.expectation.id);
    else falseAlarms.push({ trapId: a.expectation.id, finding: f });
  }
  const ids = fx.planted.map(e => e.id);
  return { planted: ids.length, hit: ids.filter(id => hit.has(id)), missed: ids.filter(id => !hit.has(id)), falseAlarms, total: findings.length, unmatched };
}

export interface SourceTally { total: number; hits: number; falseAlarms: number }

/** Per producing agent: findings, findings assigned to a planted weakness, findings assigned to a trap. */
export function scoreBySource(fx: ReviewFixture, findings: NormalizedFinding[]): Record<string, SourceTally> {
  const out: Record<string, SourceTally> = {};
  for (const f of findings) {
    const t = (out[f.source] ??= { total: 0, hits: 0, falseAlarms: 0 });
    t.total++;
    const a = assign(fx, f);
    if (a?.kind === 'planted') t.hits++;
    else if (a?.kind === 'trap') t.falseAlarms++;
  }
  return out;
}

const label = (title: string) => title.split(':')[0].trim().toLowerCase();

/** Lenient: a planted weakness counts as mentioned when one line or sentence is on topic and names its section or quote. */
export function scoreProse(fx: ReviewFixture, prose: string): { mentioned: string[]; missed: string[] } {
  const lines = prose.split(/\n+|(?<=[.!?])\s+/).map(l => l.trim()).filter(Boolean);
  const mentioned = fx.planted
    .filter(e => lines.some(line =>
      e.keywords.test(line) &&
      ((e.quoteHints ?? []).some(h => quotesOverlap(line, h)) || e.sectionTitles.some(t => line.toLowerCase().includes(label(t)))),
    ))
    .map(e => e.id);
  return { mentioned, missed: fx.planted.map(e => e.id).filter(id => !mentioned.includes(id)) };
}

/**
 * Section whose text contains the quote. Exact and normalized matches win over fuzzy ones in every section, so a
 * fuzzy match in an earlier parallel-structured section cannot steal an exact match in a later one.
 */
export function sectionTitleForQuote(sections: Pick<Section, 'title' | 'text'>[], quote: string): string | undefined {
  const usable = sections.filter(s => s.title && s.text);
  const strict = usable.find(s => {
    const m = findTextSpan(s.text, quote);
    return m !== null && m.method !== 'fuzzy';
  });
  if (strict) return strict.title;
  return usable.find(s => findTextSpan(s.text, quote) !== null)?.title;
}

export function fromSuggestions(suggestions: Suggestion[], sections: Pick<Section, 'title' | 'text'>[]): NormalizedFinding[] {
  return suggestions.map(s => ({
    quote: s.originalText,
    sectionTitle: sectionTitleForQuote(sections, s.originalText),
    text: [s.explanation, s.recommendation].filter(Boolean).join(' '),
    source: s.agent,
  }));
}
