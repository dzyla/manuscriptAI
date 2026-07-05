/**
 * Deterministic advisory detectors.
 *
 * Small local models miss mechanical, high-precision issues — a p-value with no
 * named test, a total N that differs between the abstract and the methods, an
 * acronym used before it is defined. These rule-based detectors catch those
 * classes with zero LLM involvement, so they never miss and, crucially, never
 * hallucinate: every flag quotes text that literally exists and only ever
 * *recommends an action* (it supplies no numbers or replacement text).
 *
 * Every function here is pure and operates on the plain-text manuscript, so the
 * whole module is unit-testable without a model or the DOM.
 */
import { Suggestion, SuggestionSeverity, SuggestionCategory, AgentType } from '../types';

export interface DetectorHit {
  quote: string;
  start: number;
  end: number;
  explanation: string;
  recommendation: string;
  severity: SuggestionSeverity;
  category: SuggestionCategory;
  agent: AgentType;
}

/** Named statistical tests. If one appears near a p-value, the p-value is anchored. */
const TEST_NAMES = /\b(t-?test|student'?s? t|anova|ancova|manova|chi-?squared?|χ2|χ²|fisher'?s? exact|mann-?whitney|wilcoxon|kruskal-?wallis|kolmogorov|shapiro|spearman|pearson|log-?rank|cox|regression|mixed[- ]?model|linear model|generalized linear|z-?test|f-?test|binomial|poisson|bonferroni|tukey|dunnett|sidak|holm)\b/i;

/** Common abbreviations that need no definition — skip these to avoid noise. */
const COMMON_ABBREVIATIONS = new Set([
  'DNA', 'RNA', 'PCR', 'ATP', 'ADP', 'GDP', 'GTP', 'RNA', 'MRNA', 'ELISA', 'PBS',
  'USA', 'UK', 'EU', 'WHO', 'FDA', 'NIH', 'NASA', 'PDF', 'HTML', 'URL', 'API',
  'HIV', 'AIDS', 'COVID', 'SARS', 'BMI', 'ECG', 'EKG', 'MRI', 'CT', 'PET', 'ICU',
  'OK', 'ID', 'PH', 'UV', 'IR', 'NMR', 'SD', 'SEM', 'CI', 'SE', 'IQR', 'ANOVA',
]);

interface Sentence { text: string; start: number }

/**
 * Split into sentences carrying absolute start offsets, so quotes anchor exactly.
 * A terminator only ends a sentence when it is followed by end-of-text or by
 * whitespace and an opening/uppercase character. This keeps decimals ("p < 0.01",
 * "4.2 ± 0.3") and mid-sentence abbreviations intact, which matters because the
 * statistical detectors reason over a whole sentence at a time.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[.!?]+(?:\s+|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, start: from + (raw.length - raw.trimStart().length) });
  };
  while ((m = re.exec(text)) !== null) {
    const boundaryEnd = m.index + m[0].length;
    const after = text[boundaryEnd];
    const isEnd = boundaryEnd >= text.length;
    // Not a real boundary if what follows is lowercase/digit (decimal, abbrev).
    if (!isEnd && after !== undefined && !/[A-Z("'\[]/.test(after)) continue;
    push(last, boundaryEnd);
    last = boundaryEnd;
  }
  if (last < text.length) push(last, text.length);
  return out;
}

const P_VALUE = /\bp\s*[<>=≤≥]\s*0?\.\d+|\bp\s*[<>=]\s*\.\d+/i;

/** p-value reported without the statistical test that produced it. */
function detectPValueNoTest(sentences: Sentence[]): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const s of sentences) {
    if (P_VALUE.test(s.text) && !TEST_NAMES.test(s.text)) {
      hits.push({
        quote: s.text, start: s.start, end: s.start + s.text.length,
        explanation: 'A p-value is reported without naming the statistical test that produced it.',
        recommendation: 'Name the test (e.g. two-sample t-test, ANOVA) that yielded this p-value.',
        severity: 'major', category: 'statistics', agent: 'statistician',
      });
    }
  }
  return hits;
}

const SIGNIFICANCE_CLAIM = /\bsignificant(ly)?\b[^.!?]*\b(difference|differences|increase|decrease|effect|correlation|association|reduction|improvement|higher|lower|greater|elevated|reduced|change)\b/i;

/** "significant(ly)" used for a comparison with no p-value or named test in the sentence. */
function detectSignificantNoStat(sentences: Sentence[]): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const s of sentences) {
    if (SIGNIFICANCE_CLAIM.test(s.text) && !P_VALUE.test(s.text) && !TEST_NAMES.test(s.text)) {
      hits.push({
        quote: s.text, start: s.start, end: s.start + s.text.length,
        explanation: '"Significant" is used for a comparison with no p-value or statistical test reported.',
        recommendation: 'Back the significance claim with a test and a p-value, or soften to a descriptive statement.',
        severity: 'major', category: 'statistics', agent: 'statistician',
      });
    }
  }
  return hits;
}

const MEAN_PM = /\d\s*±\s*\d/;
const SD_SEM = /\b(SD|SEM|S\.D\.|S\.E\.M|standard deviation|standard error)\b/i;

/** "mean ± x" with no indication whether x is SD or SEM. */
function detectMeanWithoutSpread(sentences: Sentence[]): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const s of sentences) {
    if (MEAN_PM.test(s.text) && !SD_SEM.test(s.text)) {
      hits.push({
        quote: s.text, start: s.start, end: s.start + s.text.length,
        explanation: 'A value is given as "x ± y" without stating whether y is the standard deviation or the standard error.',
        recommendation: 'State whether the ± value is SD or SEM.',
        severity: 'minor', category: 'statistics', agent: 'statistician',
      });
    }
  }
  return hits;
}

const PERCENT_OF = /\b\d+(\.\d+)?\s*%\s+of\b/i;
const HAS_COUNT = /\(\s*n\s*=|\/\s*\d|\bof\s+\d/i;

/** A "N% of ..." rate with no denominator/count anywhere in the sentence. */
function detectPercentNoCount(sentences: Sentence[]): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const s of sentences) {
    if (PERCENT_OF.test(s.text) && !HAS_COUNT.test(s.text)) {
      hits.push({
        quote: s.text, start: s.start, end: s.start + s.text.length,
        explanation: 'A percentage is reported without the underlying count or denominator.',
        recommendation: 'Give the count and denominator behind this percentage (e.g. 12/50).',
        severity: 'minor', category: 'statistics', agent: 'statistician',
      });
    }
  }
  return hits;
}

const UNCITED_CLAIM = /\b(studies (have )?shown|research (has )?shown|it (is|has been) (well )?(established|known|documented)|previous(ly)? (studies|work|research|reports?)|prior (studies|work)|reported to|has been shown to|are known to|is associated with)\b/i;
const HAS_CITATION = /\[\d+\]/;

/** A claim that leans on prior work but carries no [N] citation. */
function detectUncitedClaim(sentences: Sentence[]): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const s of sentences) {
    if (UNCITED_CLAIM.test(s.text) && !HAS_CITATION.test(s.text)) {
      hits.push({
        quote: s.text, start: s.start, end: s.start + s.text.length,
        explanation: 'This claim references prior work or established fact but has no citation.',
        recommendation: 'Add a citation supporting this claim.',
        severity: 'major', category: 'citation', agent: 'citation-checker',
      });
    }
  }
  return hits;
}

/**
 * Total sample size N differs across the manuscript. Capital-N "N = 42" almost
 * always denotes the total sample, so two distinct values are the classic
 * abstract-vs-methods mismatch worth surfacing (as a "reconcile" advisory, since
 * they may legitimately describe different cohorts).
 */
function detectSampleSizeMismatch(text: string): DetectorHit[] {
  const re = /\bN\s*=\s*(\d+)\b/g;
  const occ: { value: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    occ.push({ value: m[1], start: m.index, end: m.index + m[0].length });
  }
  const distinct = new Set(occ.map(o => o.value));
  if (distinct.size < 2) return [];
  const others = [...distinct];
  const seen = new Set<string>();
  const hits: DetectorHit[] = [];
  for (const o of occ) {
    if (seen.has(o.value)) continue; // one flag per distinct value
    seen.add(o.value);
    const rest = others.filter(v => v !== o.value).join(', ');
    hits.push({
      quote: text.slice(o.start, o.end), start: o.start, end: o.end,
      explanation: `Total sample size N appears as ${o.value} here but also as ${rest} elsewhere.`,
      recommendation: 'Reconcile the sample sizes or clarify which cohort each N refers to.',
      severity: 'major', category: 'structure', agent: 'consistency',
    });
  }
  return hits;
}

/**
 * Acronym used before it is defined. Flags a 3–5 letter uppercase token whose
 * first appearance is not a definition site "Full Name (ACR)" and which is never
 * defined that way anywhere. Common acronyms are skipped to avoid noise.
 */
function detectUndefinedAbbreviation(text: string): DetectorHit[] {
  const acronymRe = /\b([A-Z]{3,5})\b/g;
  const defined = new Set<string>();
  const defRe = /\(([A-Z]{3,5})\)/g;
  let dm: RegExpExecArray | null;
  while ((dm = defRe.exec(text)) !== null) defined.add(dm[1]);

  const firstSeen = new Set<string>();
  const hits: DetectorHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = acronymRe.exec(text)) !== null) {
    const acr = m[1];
    if (firstSeen.has(acr)) continue;
    firstSeen.add(acr);
    if (COMMON_ABBREVIATIONS.has(acr)) continue;
    if (defined.has(acr)) continue; // defined somewhere via "(ACR)"
    // Skip if this very occurrence is the definition site (preceded by "(").
    if (text[m.index - 1] === '(') continue;
    hits.push({
      quote: acr, start: m.index, end: m.index + acr.length,
      explanation: `The abbreviation "${acr}" is used without being defined at first use.`,
      recommendation: `Spell out "${acr}" at first use, e.g. Full Term (${acr}).`,
      severity: 'minor', category: 'structure', agent: 'consistency',
    });
  }
  return hits;
}

/**
 * Run every detector over the plain-text manuscript and return advisory
 * Suggestions ready to merge with the LLM output. Overlapping hits (same start
 * offset) are collapsed, keeping the most severe.
 */
export function detectorSuggestions(text: string): Suggestion[] {
  const sentences = splitSentences(text);
  const hits: DetectorHit[] = [
    ...detectPValueNoTest(sentences),
    ...detectSignificantNoStat(sentences),
    ...detectMeanWithoutSpread(sentences),
    ...detectPercentNoCount(sentences),
    ...detectUncitedClaim(sentences),
    ...detectSampleSizeMismatch(text),
    ...detectUndefinedAbbreviation(text),
  ];

  const RANK: Record<SuggestionSeverity, number> = { critical: 4, major: 3, minor: 2, style: 1 };
  const byStart = new Map<number, DetectorHit>();
  for (const h of hits) {
    const prev = byStart.get(h.start);
    if (!prev || RANK[h.severity] > RANK[prev.severity]) byStart.set(h.start, h);
  }

  return [...byStart.values()]
    .sort((a, b) => a.start - b.start)
    .map((h, i) => ({
      id: `detector-${i}-${h.start}`,
      originalText: h.quote,
      suggestedText: '',
      explanation: h.explanation,
      recommendation: h.recommendation,
      agent: h.agent,
      startIndex: h.start,
      endIndex: h.end,
      severity: h.severity,
      category: h.category,
      section: 'General',
      kind: 'advisory' as const,
    }));
}
