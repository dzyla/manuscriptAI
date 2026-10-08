import { callLLM, stripThinkingBlocks, lintSuggestedText } from '../ai';
import { auditText } from './metrics';
import { TELL_PATTERNS, PATTERN_NAMES, countMatches } from './patterns';
import { compareMarkers, markerTokens } from './markers';
import type { AISettings, VoiceProfile } from '../../types';

const SYSTEM =
  'You rewrite single sentences of scientific prose in the author\'s own voice. You return only the rewritten sentence or sentences, with no preamble, no quotation marks and no explanation.';

// "one" is left out: "one of the" would satisfy a dropped 1.
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20',
};

const SUPERSCRIPT: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

/** Superscripts become "^6" (so 10⁶ equals 10^6 and 10⁵ does not), subscript digits become plain digits, U+2212 becomes "-". */
function normalizeNumeric(text: string): string {
  return text
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, m => '^' + [...m].map(c => SUPERSCRIPT[c]).join(''))
    .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, m => [...m].map(c => SUPERSCRIPT[c]).join(''))
    .replace(/−/g, '-');
}

const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Numbers as plain digit strings, one entry per occurrence, so 1,200 and 1200 compare equal. */
function numericTokens(text: string): string[] {
  return (normalizeNumeric(text).match(NUMBER_RE) ?? []).map(n => n.replace(/,/g, ''));
}

function countOf(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

/** Digit tokens and spelled-out counts ("three") in the rewrite, with multiplicity. */
function numbersInRewrite(text: string): Map<string, number> {
  const items = numericTokens(text);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (NUMBER_WORDS[w]) items.push(NUMBER_WORDS[w]);
  return countOf(items);
}

/** Ratios and fractions (1:2, 3/4) must keep their order; a signed number (-3) must keep its sign. */
function ratios(text: string): string[] {
  return (normalizeNumeric(text).match(/\d+(?:\.\d+)?\s*[:/]\s*\d+(?:\.\d+)?/g) ?? []).map(r => r.replace(/\s+/g, ''));
}
function signedNumbers(text: string): string[] {
  return normalizeNumeric(text).match(/(?<![\w.\])])-\d+(?:\.\d+)?/g) ?? [];
}

// Abbreviations only. Spelled-out units ("2 hours" for "2 h") are legitimate rewrites, so time units are left to the number check.
const UNITS = '%|°C|Å|kDa|Da|kb|bp|fold|kHz|MHz|Hz|mV|rpm|×g|[mnµμpk]?[MgLl]';
const NUMBER_UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})(?![A-Za-z])`, 'g');

/** "42 nM" -> "42nM": a number and the unit it carries must stay together. */
function numberUnitPairs(text: string): string[] {
  return [...text.matchAll(NUMBER_UNIT_RE)].map(m => `${m[1]}${m[2]}`);
}

const RANGE_RE = /\b([A-Za-z]*\d+(?:\.\d+)?)\s*[–-]\s*([A-Za-z]*\d+(?:\.\d+)?)\b/g;

/** "H1–H3" and "5-10" as one normalized token each: a range must not collapse into its endpoints ("H1, H3" drops H2). */
function ranges(text: string): string[] {
  return [...text.matchAll(RANGE_RE)].map(m => `${m[1]}-${m[2]}`);
}

/** Gene, protein and reagent names: all-caps runs, letters followed by digits (TP53, EGFR, IL-6, p53), and lower-then-upper (mTOR, cGAS, mRNA). */
function identifiers(text: string): string[] {
  return text.match(/\b(?:[A-Z]{2,}[A-Za-z0-9-]*|[a-z]+[A-Z][A-Za-z0-9-]*|[A-Za-z]+\d[A-Za-z0-9-]*)\b/g) ?? [];
}

/** The text with every citation marker removed, so a marker's digits are not mistaken for data. */
function stripMarkers(t: string): string {
  let out = t;
  for (const m of [...markerTokens(t)].reverse()) out = out.slice(0, m.index) + ' ' + out.slice(m.index + m.raw.length);
  return out;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

function weightedTells(text: string): number {
  let w = 0;
  for (const name of PATTERN_NAMES) w += countMatches(TELL_PATTERNS[name], text) * TELL_PATTERNS[name].weight;
  return w;
}

/** The worst sentence's kernel severity; 0 when nothing is long enough to measure. */
function worstSeverity(text: string): number {
  return auditText(text).sentences.reduce((m, s) => Math.max(m, s.severity), 0);
}

function strongTells(text: string): string[] {
  return PATTERN_NAMES.filter(n => TELL_PATTERNS[n].weight >= 1.5 && countMatches(TELL_PATTERNS[n], text) > 0);
}

export function buildRewritePrompt(args: {
  sentence: string;
  before?: string;
  after?: string;
  profile?: VoiceProfile;
  targetWords: number;
}): string {
  const { sentence, before, after, profile, targetWords } = args;
  const examples = profile?.exampleSentences?.slice(0, 5) ?? [];
  const parts: string[] = [];
  parts.push('Rewrite the SENTENCE below from the idea up. Do not edit it word by word: say the same thing again in plain scientific English.');
  parts.push(
    [
      'Rules:',
      `- Aim for about ${targetWords} words per sentence. Two short sentences are better than one long one.`,
      '- State the claim directly. Never define something by negating an alternative ("rather than", "not X but Y", "instead of").',
      '- No semicolons, no clefts ("is what"), no ", which is" asides, no em dashes.',
      '- No throat-clearing ("Notably", "It is important to note").',
      '- Keep every number, unit, measurement, gene or protein name and citation marker such as [3] exactly as given.',
      '- Keep the meaning identical. Invent nothing.',
    ].join('\n'),
  );
  if (examples.length) {
    parts.push(`Sentences the author wrote themselves, for voice only (do not copy their content):\n${examples.map(e => `- ${e}`).join('\n')}`);
  }
  if (before || after) {
    parts.push(`Context only (do not rewrite these):\n${[before, after].filter(Boolean).join('\n')}`);
  }
  parts.push(`SENTENCE:\n${sentence}`);
  parts.push('Rewritten sentence:');
  return parts.join('\n\n');
}

/**
 * The deterministic guards. Pure over strings: no model, no network.
 * A rewrite passes only if it keeps every number (with its unit), every citation marker and every
 * gene or protein name, is not much longer, and is measurably less machine-styled than the original.
 */
export interface RewriteCheck {
  ok: boolean;
  reasons: string[];
  /** Failures that change what the sentence SAYS (numbers, units, ratios, signs, ranges, citations, names). Never applied. */
  fact: string[];
  /** Failures of the style goal (still machine-like, much longer). The text is true to the original, so it may be applied, flagged. */
  style: string[];
}

export function checkRewriteDetailed(original: string, rewrite: string): RewriteCheck {
  const fact: string[] = [];
  const style: string[] = [];
  const done = (): RewriteCheck => ({ ok: !fact.length && !style.length, reasons: [...fact, ...style], fact, style });
  const text = squash(rewrite);
  if (!text) { fact.push('The rewrite is empty.'); return done(); }
  if (text === squash(original)) { fact.push('The rewrite is identical to the original.'); return done(); }

  // Digits inside citation markers belong to the marker check below, not to the number checks.
  const o2 = stripMarkers(original);
  const t2 = stripMarkers(text);
  const haveNumbers = numbersInRewrite(t2);
  const origNumbers = countOf(numericTokens(o2));
  for (const [n, c] of origNumbers) {
    const have = haveNumbers.get(n) ?? 0;
    if (have === 0) fact.push(`The number ${n} is missing from the rewrite.`);
    else if (have < c) fact.push(`The number ${n} appears ${c} times in the original but ${have} in the rewrite.`);
  }
  const rewriteDigits = countOf(numericTokens(t2));
  for (const n of rewriteDigits.keys()) {
    if (!origNumbers.has(n)) fact.push(`The rewrite introduces the number ${n}, which is not in the original.`);
  }
  const haveUnits = numberUnitPairs(t2);
  for (const u of new Set(numberUnitPairs(o2))) {
    if (!haveUnits.includes(u) && haveNumbers.has(u.match(/^[\d.]+/)![0])) {
      fact.push(`The unit in "${u}" is missing or detached from its number.`);
    }
  }
  const haveRatios = ratios(t2);
  for (const r of new Set(ratios(o2))) if (!haveRatios.includes(r)) fact.push(`The ratio ${r} is missing or inverted.`);
  const haveSigned = signedNumbers(t2);
  for (const n of new Set(signedNumbers(o2))) if (!haveSigned.includes(n)) fact.push(`The sign of ${n} was lost.`);
  const haveRanges = ranges(t2);
  for (const r of new Set(ranges(o2))) {
    if (!haveRanges.includes(r) && !t2.includes(r.replace('-', ' to '))) fact.push(`The range ${r} is missing or was split into its endpoints.`);
  }
  // Citation markers compare as a multiset: dropped, duplicated, invented and merged markers all differ.
  const cites = compareMarkers(original, text);
  for (const c of cites.missing) fact.push(`The citation ${c} is missing from the rewrite.`);
  for (const c of cites.extra) fact.push(`The rewrite has a citation ${c} that the original does not.`);
  for (const id of new Set(identifiers(original))) {
    if (!text.includes(id)) fact.push(`The name ${id} is missing from the rewrite.`);
  }
  if (words(text) > Math.ceil(words(original) * 1.25)) {
    style.push('The rewrite is much longer than the original.');
  }

  const kept = strongTells(original).filter(n => strongTells(text).includes(n));
  const tellsDown = weightedTells(original) === 0 ? weightedTells(text) === 0 : weightedTells(text) < weightedTells(original);
  if (kept.length || !tellsDown || worstSeverity(text) >= worstSeverity(original)) {
    style.push(
      kept.length
        ? `The rewrite does not improve the style score: it still contains ${kept.map(k => `"${k}"`).join(', ')}.`
        : 'The rewrite does not improve the style score.',
    );
  }
  return done();
}

/** The brief's interface: pass/fail with every reason. */
export function checkRewrite(original: string, rewrite: string): { ok: boolean; reasons: string[] } {
  const { ok, reasons } = checkRewriteDetailed(original, rewrite);
  return { ok, reasons };
}

/**
 * Lint the reply for the house dash rule only. The original is passed as '' on purpose: with the original,
 * lintSuggestedText re-appends citation markers the model dropped, at an arbitrary position and before the
 * guards run, so a rewrite that lost every citation would pass unflagged.
 */
function cleanReply(raw: string): string {
  const stripped = stripThinkingBlocks(raw)
    .replace(/^\s*(?:rewritten sentence|rewrite|sentence)\s*:\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  return stripped ? lintSuggestedText(stripped, '') : '';
}

export async function rewriteSentence(args: {
  sentence: string;
  before?: string;
  after?: string;
  profile?: VoiceProfile;
  settings: AISettings;
  signal?: AbortSignal;
}): Promise<{ text: string; retried: boolean; warnings: string[] }> {
  const targetWords = Math.max(10, Math.round(args.profile?.summary.meanWords ?? 18));
  const base = buildRewritePrompt({ ...args, targetWords });

  const attempt = async (extra?: string) => {
    if (args.signal?.aborted) throw new DOMException('Rewrite cancelled', 'AbortError');
    const prompt = extra ? `${base}\n\nYour previous attempt was rejected: ${extra}\nWrite it again and fix that.` : base;
    const raw = await callLLM(prompt, args.settings, SYSTEM, false, undefined, args.signal, 400);
    const text = cleanReply(raw);
    return { text, check: checkRewriteDetailed(args.sentence, text) };
  };

  const first = await attempt();
  if (first.check.ok) return { text: first.text, retried: false, warnings: [] };

  const second = await attempt(first.check.reasons.join(' '));
  if (second.check.ok) return { text: second.text, retried: true, warnings: [] };

  // Both attempts failed a guard. A failure that changes a fact (a number, unit, ratio, sign, range, citation or name) is never
  // handed back: that text would go into the grant. A style-only failure is true to the original, so the better attempt is
  // returned, flagged. "Better" = fewer fact failures, then fewer failures in all; a tie goes to the second attempt.
  const better = (a: typeof first, b: typeof first) =>
    b.check.fact.length !== a.check.fact.length ? b.check.fact.length < a.check.fact.length : b.check.reasons.length <= a.check.reasons.length;
  const best = better(first, second) ? second : first;
  if (!best.text || squash(best.text) === squash(args.sentence)) {
    throw new Error(`The model did not produce a usable rewrite. ${best.check.reasons[0] ?? ''}`.trim());
  }
  if (best.check.fact.length) {
    throw new Error(`The model did not produce a safe rewrite. ${best.check.fact[0]}`);
  }
  return { text: best.text, retried: true, warnings: best.check.reasons };
}

/** The sentence before and after [start, end) in the SAME paragraph, for context only. */
export function neighbourSentences(plain: string, start: number, end: number): { before?: string; after?: string } {
  const lastSentence = (s: string) => s.split(/(?<=[.!?])\s+/).pop()?.trim() || undefined;
  const firstSentence = (s: string) => s.split(/(?<=[.!?])\s+/)[0]?.trim() || undefined;
  const paraStart = plain.lastIndexOf('\n\n', start - 1);
  const paraEndAt = plain.indexOf('\n\n', end);
  const head = plain.slice(paraStart < 0 ? 0 : paraStart + 2, start).trim();
  const tail = plain.slice(end, paraEndAt < 0 ? plain.length : paraEndAt).trim();
  return { before: head ? lastSentence(head) : undefined, after: tail ? firstSentence(tail) : undefined };
}
