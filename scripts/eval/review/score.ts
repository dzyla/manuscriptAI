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
/** Containment only counts when the contained (shorter) string has at least this many words. */
const MIN_CONTAINED_WORDS = 3;

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
  if (shorter.split(' ').length >= MIN_CONTAINED_WORDS && longer.includes(shorter)) return true;
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
 * Assign a finding to at most one expectation: planted by quote, planted by location, trap by quote, trap by location.
 * Within a tier the expectation with the finding's checkId wins, then fixture order.
 */
export function assign(fx: ReviewFixture, f: NormalizedFinding): Assignment | null {
  const tiers: [Expectation[], Assignment['kind'], (e: Expectation, f: NormalizedFinding) => boolean][] = [
    [fx.planted, 'planted', quoteHit],
    [fx.planted, 'planted', locationHit],
    [fx.traps, 'trap', quoteHit],
    [fx.traps, 'trap', locationHit],
  ];
  for (const [list, kind, hit] of tiers) {
    const candidates = list.filter(e => onTopic(e, f) && hit(e, f));
    if (candidates.length) return { expectation: candidates.find(e => e.checkId === f.checkId) ?? candidates[0], kind };
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
