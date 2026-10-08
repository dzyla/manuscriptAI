export interface TellPattern {
  re: RegExp;        // global; recreate per use or reset lastIndex
  weight: number;
  label: string;
  kernel: boolean;   // part of the human-prose-audit kernel (parity-tested)
}

/**
 * Vocabulary over-represented in LLM prose. Counted as one tell per occurrence. The spec also lists robust, comprehensive and
 * crucial; they are left out because they are ordinary scientific words ("robust fit", "comprehensive screen") and would flag legitimate prose.
 */
export const STOCK_WORDS =
  /\b(?:delve[sd]?|underscore[sd]?|pivotal|intricate|tapestry|landscape|multifaceted|nuanced|foster(?:ing|s)?|showcase[sd]?|leverag(?:e|es|ing)|seamless(?:ly)?|paramount|realm|testament)\b/gi;

/*
 * Kernel patterns are deliberately case-SENSITIVE, exactly like kernel.py (re.findall
 * with re.M and no IGNORECASE). A sentence-initial "Rather than" or "Instead of" is
 * therefore not counted. The skill's calibration rates were measured that way, so
 * counting the extra sentence-initial hits would inflate a draft against the
 * reference and distort the score. Only the non-kernel additions below that need
 * case-insensitivity (stock vocabulary, not only / but also) carry the i flag.
 */
export const TELL_PATTERNS: Record<string, TellPattern> = {
  // ─── kernel patterns (parity-tested against kernel.py) ───
  'rather than': { re: /\brather than\b/g, weight: 2, label: 'contrastive definition', kernel: true },
  'not X but/instead': { re: /\b(?:is|are|was|were)\s+not\b[^.]{0,60}\b(?:but|instead)\b/g, weight: 2, label: 'negated definition', kernel: true },
  'instead of': { re: /\binstead of\b/g, weight: 1.5, label: 'contrastive definition', kernel: true },
  'is what cleft': { re: /\bis what\b/g, weight: 1.5, label: 'cleft', kernel: true },
  'which is appositive': { re: /,\s*which is\b/g, weight: 1.5, label: 'appositive pile-up', kernel: true },
  'initial Because': { re: /(?:^|\.\s+)Because\b/gm, weight: 1, label: 'sentence-initial subordination', kernel: true },
  'This/That anaphora': { re: /(?:^|\.\s+)(?:This|That|These|Those)\s+(?:is|are|makes|means|allows)\b/gm, weight: 1, label: 'vague anaphora', kernel: true },
  semicolon: { re: /;/g, weight: 1.5, label: 'semicolon', kernel: true },
  tricolon: { re: /\b\w+,\s+\w+[^.,;]{0,25},\s+and\s+\w+/g, weight: 0.5, label: 'list of three', kernel: true },
  'throat-clearing': { re: /\b(?:It is important to note|Notably|Interestingly|It should be emphasized)\b/g, weight: 1, label: 'throat-clearing', kernel: true },
  // ─── additions ───
  'em dash': { re: /—/g, weight: 1, label: 'em dash', kernel: false },
  'not only but also': { re: /\bnot only\b[^.]{0,80}\bbut also\b/gi, weight: 1.5, label: 'paired correlative', kernel: false },
  'paragraph connective': { re: /(?:^|\n)\s*(?:Moreover|Furthermore|Additionally)\b/gm, weight: 1, label: 'paragraph-initial connective', kernel: false },
  'summary flourish': { re: /(?:^|\.\s+|\n)\s*(?:In summary|Overall,|Taken together|In conclusion)\b/gm, weight: 1, label: 'summary flourish', kernel: false },
  'stock vocabulary': { re: STOCK_WORDS, weight: 1, label: 'stock vocabulary', kernel: false },
};

export const KERNEL_PATTERN_NAMES = Object.entries(TELL_PATTERNS)
  .filter(([, p]) => p.kernel)
  .map(([name]) => name) as readonly string[];

export const PATTERN_NAMES = Object.keys(TELL_PATTERNS) as readonly string[];

/** Count non-overlapping matches without leaking regex state between calls. */
export function countMatches(pattern: TellPattern, text: string): number {
  const re = new RegExp(pattern.re.source, pattern.re.flags);
  let n = 0;
  while (re.exec(text) !== null) {
    n++;
    if (re.lastIndex === 0) break; // zero-length match guard
  }
  return n;
}
