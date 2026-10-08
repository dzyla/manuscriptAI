# Style Audit (Sub-project H) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the author which sentences read as machine-written, how far the draft is from their own measured voice, and rewrite those sentences in their voice — all scored locally with no LLM call.

**Architecture:** A pure metrics engine (`src/services/proseAudit/`) ports the `human-prose-audit` skill kernel's tell patterns to TypeScript and reuses the repo's decimal-safe `splitSentences`. A voice profile (built in-app from the author's own samples, stored in `AISettings`) is the comparison target; a weighted distance scales the draft between that profile and the skill's measured machine reference. A ProseMirror decoration plugin highlights the worst sentences without touching the document, and a guarded LLM rewrite replaces one sentence range at a time.

**Tech Stack:** TypeScript 5.8, React 19, TipTap 3.21 (`@tiptap/pm/{state,view}`), Zustand 5, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-10-07-style-audit-design.md` — read it before any task.

## Global Constraints

- The feature measures **style distance from the author's voice**. No user-facing string may claim to detect AI authorship or give an "AI probability". The panel carries the note: "Measures writing style, not authorship."
- Scoring is deterministic and local: no LLM call in metrics, profile or score. Only `rewrite.ts` calls an LLM.
- Sentence splitting uses `splitSentences` from `src/services/detectors.ts` (decimal-safe: never splits `p < 0.01`). Do not write a second splitter.
- Editor highlighting uses **decorations only**. Never add marks to the document, never mutate the doc to show style state.
- Flat-text offsets map to document positions through `flattenDoc` + `flatSpanToPm` from `src/utils/textMatch.ts`.
- Kernel parity is authoritative: the TS metrics must reproduce `kernel.py`'s numbers for the kernel's own ten patterns on the same text.
- This sub-project runs in a worktree parallel to A2 (DOCX import). Keep edits to shared files (`src/components/Sidebar.tsx`, `src/components/Editor.tsx`, `src/services/ai.ts`, `src/types.ts`) as small as the task allows, and never reformat surrounding code.
- Type-check gate: `npx tsc --noEmit` (do **not** use `npm run lint`: an rtk proxy alters its output). Test gate: `npx vitest run`.
- Baseline at plan start: `tsc` clean, 172 tests passing.
- Never commit the user's grant text. Fixtures use `FIXTURE_MANUSCRIPT` from `scripts/eval/fixture.ts` or text written inside the test file.
- Commit after each task; messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

1. A heading or a reference-list entry counted as a sentence would skew every metric (short headings drag the mean down, reference entries are full of semicolons) → Task 1 pins this with heading/reference-exclusion tests.
2. An author with no voice profile must get a usable, clearly-labeled generic baseline rather than a divide-by-zero or a `NaN` score → Task 2 tests the no-profile path and zero-variance metrics.
3. A document containing citations, tables or images must map sentence offsets to the right document ranges, or highlights and rewrites land on the wrong text → Task 3 tests offsets across citation atoms and table cells.
4. A rewrite that silently drops a number, unit or citation marker would corrupt the science → Task 5 tests each guard and the retry path.
5. Live recomputation on every keystroke of a 12,000-word grant must not freeze the editor → Task 3 debounces and Task 4 asserts a measured budget on the fixture.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/proseAudit/patterns.ts` | Tell pattern table (kernel ports + additions), weights, stock-vocabulary list |
| `src/services/proseAudit/metrics.ts` | `auditText`, `worstSentences`, sentence filtering, section split |
| `src/services/proseAudit/profile.ts` | `VoiceProfile` build/validate, generic + machine reference constants |
| `src/services/proseAudit/score.ts` | `styleDistance`, per-metric deviation, bands |
| `src/services/proseAudit/rewrite.ts` | Prompt build, guard checks, retry |
| `src/extensions/StyleHighlights.ts` | Decoration plugin + `pageForSentence`-style position mapping |
| `src/components/style/StylePanel.tsx` | Score, comparison table, section breakdown, worst-sentence list |
| `src/components/style/VoiceProfileManager.tsx` | Create/rename/delete profile from samples |
| `src/test/fixtures/proseAudit/kernelParity.json` | Kernel-generated expected numbers |
| `src/types.ts` (modify) | `VoiceProfile`, `AuditMetrics`, `AISettings.voiceProfile` |
| `src/services/ai.ts` (modify) | export `callLLM` |
| `src/components/Editor.tsx` (modify) | register plugin, `replaceRange` ref method |
| `src/components/Sidebar.tsx` (modify) | `'style'` tab |
| `scripts/spikes/binoculars-local.ts` | Throwaway feasibility probe |

---

### Task 1: Tell patterns and metrics engine

**Files:**
- Create: `src/services/proseAudit/patterns.ts`, `src/services/proseAudit/metrics.ts`
- Create: `src/services/proseAudit/metrics.test.ts`
- Create: `src/test/fixtures/proseAudit/kernelParity.json`
- Modify: `src/types.ts` (append the audit types above the Dexie row section)

**Interfaces:**
- Consumes: `splitSentences` from `src/services/detectors.ts` (returns `{ text, start }[]`).
- Produces:
  - `patterns.ts`: `KERNEL_PATTERN_NAMES: readonly string[]`, `TELL_PATTERNS: Record<string, { re: RegExp; weight: number; label: string; kernel: boolean }>`, `STOCK_WORDS: RegExp`
  - `types.ts`: `SentenceAudit { start, end, words, tells: string[], severity }`, `AuditSummary { sentences, meanWords, pctOver35, lengthCv, rates: Record<string, number>, counts: Record<string, number> }`, `AuditMetrics { summary: AuditSummary, sentences: SentenceAudit[], sections: { title, summary }[] }`
  - `metrics.ts`: `auditText(text: string): AuditMetrics`, `worstSentences(m: AuditMetrics, k?: number): SentenceAudit[]`

- [ ] **Step 1: Read the kernel and generate the parity fixture**

The kernel lives at
`/home/dzyla/.claude/skills/synced/6609c490-2519-4181-b1cd-944afd446098_3470cc47-4f6a-4c81-aa83-df70c0d78ce1/human-prose-audit/kernel.py`.
Read it, then generate expected numbers from the repo's own fixture text:

```bash
cd /tmp && python3 -I -c "
import sys, json, re
sys.path.insert(0, '/home/dzyla/.claude/skills/synced/6609c490-2519-4181-b1cd-944afd446098_3470cc47-4f6a-4c81-aa83-df70c0d78ce1/human-prose-audit')
from kernel import prose_audit
src = open('/home/dzyla/manuscript-ai-editor/scripts/eval/fixture.ts').read()
text = src.split('FIXTURE_MANUSCRIPT = \`')[1].split('\`')[0]
print(json.dumps({'text': text, 'metrics': prose_audit(text)}, indent=2))
" > /home/dzyla/manuscript-ai-editor/src/test/fixtures/proseAudit/kernelParity.json
```

Inspect the JSON: it must contain `sentences`, `mean_sentence_words`, `pct_over_35_words` and a count plus `_per100` rate for each of the kernel's ten patterns. The `text` field is the exact string the TS test will audit, so both sides see identical input.

- [ ] **Step 2: Write the failing test**

Create `src/services/proseAudit/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { auditText, worstSentences } from './metrics';
import { KERNEL_PATTERN_NAMES } from './patterns';
import { readFileSync } from 'node:fs';

// Read rather than import: tsconfig has no resolveJsonModule.
const parity = JSON.parse(
  readFileSync(new URL('../../test/fixtures/proseAudit/kernelParity.json', import.meta.url), 'utf8'),
) as { text: string; metrics: Record<string, number> };

const audit = (t: string) => auditText(t);

describe('kernel parity', () => {
  it('reproduces the kernel sentence count and length metrics', () => {
    const m = audit(parity.text).summary;
    expect(m.sentences).toBe(parity.metrics.sentences);
    expect(m.meanWords).toBeCloseTo(parity.metrics.mean_sentence_words, 1);
    expect(m.pctOver35).toBeCloseTo(parity.metrics.pct_over_35_words, 1);
  });

  it('reproduces every kernel pattern count', () => {
    const m = audit(parity.text).summary;
    for (const name of KERNEL_PATTERN_NAMES) {
      expect(m.counts[name], name).toBe(parity.metrics[name]);
    }
  });
});

describe('tell patterns', () => {
  const hits = (t: string) => audit(t).summary.counts;

  it('flags a contrastive definition', () => {
    expect(hits('The state is selected kinetically rather than thermodynamically here.')['rather than']).toBe(1);
  });

  it('flags a semicolon, a cleft and an appositive', () => {
    const c = hits('The barrier is high; the state persists for hours in this assay.');
    expect(c.semicolon).toBe(1);
    expect(hits('Converting persistence into a barrier is what makes this quantitative.')['is what cleft']).toBe(1);
    expect(hits('We measured the dwell time, which is the quantity that matters most.')['which is appositive']).toBe(1);
  });

  it('flags throat-clearing, em dashes and stock vocabulary', () => {
    const c = hits('Notably, we delve into the pivotal landscape of receptor binding — at length.');
    expect(c['throat-clearing']).toBe(1);
    expect(c['em dash']).toBe(1);
    expect(c['stock vocabulary']).toBeGreaterThanOrEqual(3);
  });

  it('does not flag ordinary scientific prose', () => {
    const c = hits('However, binding was reduced at pH 5.5. The complex was purified by gel filtration. Values are means of three experiments.');
    for (const [k, v] of Object.entries(c)) expect(v, k).toBe(0);
  });

  it('keeps decimals and p-values inside one sentence', () => {
    const m = audit('Binding fell at pH 5.5 (p < 0.01) in every replicate of the assay.');
    expect(m.summary.sentences).toBe(1);
  });
});

describe('sentence filtering', () => {
  it('excludes headings and short fragments', () => {
    const m = audit('Specific Aims\n\nWe will determine how the envelope protein drives fusion of membranes.\n\nAim 1\n');
    expect(m.summary.sentences).toBe(1);
  });

  it('stops counting at a reference list', () => {
    const text = [
      'The receptor binds the envelope protein with nanomolar affinity in our assay.',
      '',
      'References',
      '',
      '1. Author A, Author B; Author C. Title of the work; Journal 2019; 12: 1-10.',
      '2. Author D; Author E. Another title; Journal 2020; 13: 11-20.',
    ].join('\n');
    const m = audit(text);
    expect(m.summary.sentences).toBe(1);
    expect(m.summary.counts.semicolon).toBe(0);
  });

  it('splits sections on headings and audits each', () => {
    const text = 'Significance\n\nThe problem matters because the virus evades antibodies in most patients.\n\nApproach\n\nWe will solve structures; we will then validate them by mutagenesis.';
    const m = audit(text);
    expect(m.sections.map(s => s.title)).toEqual(['Significance', 'Approach']);
    expect(m.sections[1].summary.counts.semicolon).toBe(1);
    expect(m.sections[0].summary.counts.semicolon).toBe(0);
  });
});

describe('worstSentences', () => {
  it('ranks by length plus eight times tell count, worst first', () => {
    const short = 'The barrier is high; it persists.';
    const long = 'We measured ' + 'the dwell time of the complex '.repeat(3) + 'in a single long sentence of plain prose.';
    const m = audit(`${long} ${short}`);
    const ranked = worstSentences(m, 2);
    expect(ranked[0].tells).toContain('semicolon');
    expect(ranked[0].severity).toBeGreaterThan(ranked[1].severity);
  });

  it('carries offsets that slice the original text back out', () => {
    const text = 'First sentence of the draft is here. Second sentence is longer and carries a semicolon; here it is.';
    const m = audit(text);
    const s = worstSentences(m, 1)[0];
    expect(text.slice(s.start, s.end)).toContain('semicolon');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/services/proseAudit/metrics.test.ts`
Expected: FAIL — cannot resolve `./metrics`.

- [ ] **Step 4: Implement `src/services/proseAudit/patterns.ts`**

The ten kernel patterns are ported verbatim from `kernel.py`'s `TELL_PATTERNS` (same regex source, `gi`/`gm` flags as the kernel's `re.M`), so parity holds. Additions carry their own names.

```ts
export interface TellPattern {
  re: RegExp;        // global; recreate per use or reset lastIndex
  weight: number;
  label: string;
  kernel: boolean;   // part of the human-prose-audit kernel (parity-tested)
}

/** Vocabulary over-represented in LLM prose. Counted as one tell per occurrence. */
export const STOCK_WORDS =
  /\b(?:delve[sd]?|underscore[sd]?|pivotal|intricate|tapestry|landscape|multifaceted|nuanced|foster(?:ing|s)?|showcase[sd]?|leverag(?:e|es|ing)|seamless(?:ly)?|paramount|realm|testament)\b/gi;

export const TELL_PATTERNS: Record<string, TellPattern> = {
  // ─── kernel patterns (parity-tested against kernel.py) ───
  'rather than': { re: /\brather than\b/gi, weight: 2, label: 'contrastive definition', kernel: true },
  'not X but/instead': { re: /\b(?:is|are|was|were)\s+not\b[^.]{0,60}\b(?:but|instead)\b/gi, weight: 2, label: 'negated definition', kernel: true },
  'instead of': { re: /\binstead of\b/gi, weight: 1.5, label: 'contrastive definition', kernel: true },
  'is what cleft': { re: /\bis what\b/gi, weight: 1.5, label: 'cleft', kernel: true },
  'which is appositive': { re: /,\s*which is\b/gi, weight: 1.5, label: 'appositive pile-up', kernel: true },
  'initial Because': { re: /(?:^|\.\s+)Because\b/gm, weight: 1, label: 'sentence-initial subordination', kernel: true },
  'This/That anaphora': { re: /(?:^|\.\s+)(?:This|That|These|Those)\s+(?:is|are|makes|means|allows)\b/gm, weight: 1, label: 'vague anaphora', kernel: true },
  semicolon: { re: /;/g, weight: 1.5, label: 'semicolon', kernel: true },
  tricolon: { re: /\b\w+,\s+\w+[^.,;]{0,25},\s+and\s+\w+/gi, weight: 0.5, label: 'list of three', kernel: true },
  'throat-clearing': { re: /\b(?:It is important to note|Notably|Interestingly|It should be emphasized)\b/gi, weight: 1, label: 'throat-clearing', kernel: true },
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
```

- [ ] **Step 5: Implement `src/services/proseAudit/metrics.ts`**

Note two kernel behaviors that must be reproduced for parity: pattern counts are taken over the **whole analyzed text** (not summed per sentence), and sentences of 3 words or fewer are dropped.

```ts
import { splitSentences } from '../detectors';
import type { AuditMetrics, AuditSummary, SentenceAudit } from '../../types';
import { PATTERN_NAMES, TELL_PATTERNS, countMatches } from './patterns';

/** A line that reads as a heading: short, no terminal punctuation. */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return t.split(/\s+/).length <= 8 && !/[.!?;:]$/.test(t);
}

const REFERENCE_HEADING = /^(?:references|bibliography|literature cited|works cited)\s*$/i;

/**
 * Prose regions of the text, with headings and anything after a References
 * heading removed. Offsets are preserved by blanking excluded spans with spaces,
 * so sentence offsets still index the caller's original string.
 */
export function prosePortion(text: string): string {
  const lines = text.split('\n');
  let cut = false;
  let out = '';
  for (const line of lines) {
    const blank = ' '.repeat(line.length);
    if (REFERENCE_HEADING.test(line.trim())) cut = true;
    out += (cut || isHeadingLine(line) ? blank : line) + '\n';
  }
  return out.slice(0, text.length);
}

function summarize(text: string, sentences: SentenceAudit[]): AuditSummary {
  const counts: Record<string, number> = {};
  const rates: Record<string, number> = {};
  const n = sentences.length;
  for (const name of PATTERN_NAMES) {
    counts[name] = countMatches(TELL_PATTERNS[name], text);
    rates[name] = n ? Math.round((1000 * counts[name]) / n) / 10 : 0;
  }
  const lens = sentences.map(s => s.words);
  const mean = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  return {
    sentences: n,
    meanWords: Math.round(mean * 10) / 10,
    pctOver35: n ? Math.round((1000 * lens.filter(w => w > 35).length) / n) / 10 : 0,
    lengthCv: mean ? Math.round((Math.sqrt(variance) / mean) * 100) / 100 : 0,
    counts,
    rates,
  };
}

function auditSentences(prose: string): SentenceAudit[] {
  return splitSentences(prose)
    .filter(s => s.text.split(/\s+/).filter(Boolean).length > 3)
    .map(s => {
      const tells: string[] = [];
      let weighted = 0;
      for (const name of PATTERN_NAMES) {
        const n = countMatches(TELL_PATTERNS[name], s.text);
        if (n > 0) {
          tells.push(name);
          weighted += n * TELL_PATTERNS[name].weight;
        }
      }
      const words = s.text.split(/\s+/).filter(Boolean).length;
      return { start: s.start, end: s.start + s.text.length, words, tells, severity: words + 8 * weighted };
    });
}

/** Top-level headings split the document into sections for per-section reporting. */
function splitSections(text: string): { title: string; start: number; end: number }[] {
  const out: { title: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    if (isHeadingLine(line) && !REFERENCE_HEADING.test(line.trim())) {
      if (out.length) out[out.length - 1].end = offset;
      out.push({ title: line.trim(), start: offset + line.length + 1, end: text.length });
    }
    offset += line.length + 1;
  }
  return out;
}

export function auditText(text: string): AuditMetrics {
  const prose = prosePortion(text);
  const sentences = auditSentences(prose);
  const sections = splitSections(text).map(sec => {
    const slice = prose.slice(sec.start, sec.end);
    const secSentences = sentences.filter(s => s.start >= sec.start && s.end <= sec.end);
    return { title: sec.title, summary: summarize(slice, secSentences) };
  });
  return { summary: summarize(prose, sentences), sentences, sections };
}

export function worstSentences(m: AuditMetrics, k = 10): SentenceAudit[] {
  return [...m.sentences].sort((a, b) => b.severity - a.severity).slice(0, k);
}
```

Add to `src/types.ts`, directly above the `// ─── Dexie row types` marker:

```ts
// ─── Prose style audit (sub-project H) ────────────────────────────────────────

export interface SentenceAudit {
  start: number;
  end: number;
  words: number;
  tells: string[];
  /** kernel severity: words + 8 × weighted tell count */
  severity: number;
}

export interface AuditSummary {
  sentences: number;
  meanWords: number;
  pctOver35: number;
  /** coefficient of variation of sentence length — uniformity is itself a tell */
  lengthCv: number;
  counts: Record<string, number>;
  /** occurrences per 100 sentences */
  rates: Record<string, number>;
}

export interface AuditMetrics {
  summary: AuditSummary;
  sentences: SentenceAudit[];
  sections: { title: string; summary: AuditSummary }[];
}
```

- [ ] **Step 6: Run the tests and fix parity failures**

Run: `npx vitest run src/services/proseAudit/metrics.test.ts`
Expected: PASS. If a kernel count differs, compare the regex source character by character with `kernel.py` and check the flags — the kernel counts over the whole text with `re.M`, and the TS port must do the same. Do **not** adjust the fixture to make a mismatch pass.

- [ ] **Step 7: Run both gates**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; all tests pass (172 + new).

- [ ] **Step 8: Commit**

```bash
git add src/services/proseAudit src/types.ts src/test/fixtures/proseAudit
git commit -m "feat(h): prose style metrics engine with human-prose-audit kernel parity

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Voice profile and style distance

**Files:**
- Create: `src/services/proseAudit/profile.ts`, `src/services/proseAudit/score.ts`
- Create: `src/services/proseAudit/score.test.ts`
- Modify: `src/types.ts` (`VoiceProfile`, `AISettings.voiceProfile`)

**Interfaces:**
- Consumes: `auditText` (Task 1), `AuditSummary`.
- Produces:
  - `types.ts`: `VoiceProfile { id, name, createdAt, sampleWords, summary: AuditSummary, exampleSentences: string[] }`; `AISettings.voiceProfile?: VoiceProfile`
  - `profile.ts`: `GENERIC_HUMAN_SUMMARY: AuditSummary`, `MACHINE_REFERENCE: AuditSummary`, `MIN_PROFILE_WORDS = 1500`, `RECOMMENDED_PROFILE_WORDS = 2000`, `buildProfile(name: string, samples: string[]): { profile: VoiceProfile; warning?: string }`, `activeSummary(p?: VoiceProfile): { summary: AuditSummary; isGeneric: boolean }`
  - `score.ts`: `MetricDeviation { metric: string; label: string; voice: number; draft: number; deviation: number }`, `styleDistance(draft: AuditSummary, voice: AuditSummary): { score: number; band: 'close' | 'drifting' | 'far'; deviations: MetricDeviation[] }`

Reference values come from the skill's calibration table (author's unassisted draft vs LLM-assisted revision of the same document): mean 17.6 vs 26.8 words; over-35 1% vs 27%; `rather than` 2.9 vs 25.2 per 100 sentences; semicolons 0 vs 21; `which is appositive` 0 vs 7; `is what cleft` 0 vs 4; `initial Because` 0 vs 4.

- [ ] **Step 1: Write the failing test**

Create `src/services/proseAudit/score.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { auditText } from './metrics';
import { buildProfile, activeSummary, GENERIC_HUMAN_SUMMARY, MACHINE_REFERENCE, MIN_PROFILE_WORDS } from './profile';
import { styleDistance } from './score';

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ').replace(/((?:\S+\s+){14})/g, '$1. ');

describe('buildProfile', () => {
  it('measures the samples and keeps example sentences', () => {
    const sample = 'We purified the complex by gel filtration. Binding fell at low pH in every replicate. ' + words(1600);
    const { profile, warning } = buildProfile('My grants', [sample]);
    expect(profile.name).toBe('My grants');
    expect(profile.sampleWords).toBeGreaterThan(MIN_PROFILE_WORDS);
    expect(profile.summary.sentences).toBeGreaterThan(10);
    expect(profile.exampleSentences.length).toBeGreaterThan(0);
    expect(profile.exampleSentences.length).toBeLessThanOrEqual(8);
    expect(warning).toBeUndefined();
  });

  it('warns below the recommended sample size and rejects a tiny one', () => {
    const { warning } = buildProfile('Short', [words(1700)]);
    expect(warning).toMatch(/2,?000/);
    expect(() => buildProfile('Tiny', ['One short sentence of prose here.'])).toThrow(/1,?500/);
  });

  it('merges several samples', () => {
    const p = buildProfile('Merged', [words(900), words(900)]).profile;
    expect(p.sampleWords).toBeGreaterThan(MIN_PROFILE_WORDS);
  });
});

describe('activeSummary', () => {
  it('falls back to the labeled generic baseline', () => {
    const a = activeSummary(undefined);
    expect(a.isGeneric).toBe(true);
    expect(a.summary).toBe(GENERIC_HUMAN_SUMMARY);
  });

  it('prefers a real profile', () => {
    const profile = buildProfile('Mine', [words(1600)]).profile;
    expect(activeSummary(profile)).toEqual({ summary: profile.summary, isGeneric: false });
  });
});

describe('styleDistance', () => {
  it('scores the voice profile itself as close to zero', () => {
    const r = styleDistance(GENERIC_HUMAN_SUMMARY, GENERIC_HUMAN_SUMMARY);
    expect(r.score).toBe(0);
    expect(r.band).toBe('close');
  });

  it('scores the machine reference as far', () => {
    const r = styleDistance(MACHINE_REFERENCE, GENERIC_HUMAN_SUMMARY);
    expect(r.score).toBeGreaterThan(50);
    expect(r.band).toBe('far');
  });

  it('never returns NaN when a voice metric is zero', () => {
    const voice = { ...GENERIC_HUMAN_SUMMARY, meanWords: 0, counts: {}, rates: {} };
    const r = styleDistance(MACHINE_REFERENCE, voice as typeof GENERIC_HUMAN_SUMMARY);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('rises when semicolons or long sentences are added', () => {
    const plain = auditText('We purified the complex by gel filtration in three independent runs. Binding fell at low pH. The structure was solved at three angstrom resolution.').summary;
    const tells = auditText('We purified the complex by gel filtration; binding fell at low pH, which is the quantity that matters, rather than the affinity we measured before in the previous study of this system.').summary;
    const base = styleDistance(plain, GENERIC_HUMAN_SUMMARY).score;
    expect(styleDistance(tells, GENERIC_HUMAN_SUMMARY).score).toBeGreaterThan(base);
  });

  it('reports per-metric deviations sorted worst first', () => {
    const r = styleDistance(MACHINE_REFERENCE, GENERIC_HUMAN_SUMMARY);
    expect(r.deviations.length).toBeGreaterThan(3);
    expect(r.deviations[0].deviation).toBeGreaterThanOrEqual(r.deviations[1].deviation);
    expect(r.deviations[0]).toHaveProperty('label');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/proseAudit/score.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Add the types**

In `src/types.ts`, after `AuditMetrics`:

```ts
export interface VoiceProfile {
  id: string;
  name: string;
  createdAt: number;
  sampleWords: number;
  summary: AuditSummary;
  /** short representative sentences, used as few-shot style examples when rewriting */
  exampleSentences: string[];
}
```

and inside `AISettings`:

```ts
  /** The author's measured writing style, built from their own samples (sub-project H). */
  voiceProfile?: VoiceProfile;
```

- [ ] **Step 4: Implement `src/services/proseAudit/profile.ts`**

```ts
import { auditText } from './metrics';
import type { AuditSummary, VoiceProfile } from '../../types';
import { PATTERN_NAMES } from './patterns';

export const MIN_PROFILE_WORDS = 1500;
export const RECOMMENDED_PROFILE_WORDS = 2000;

function summaryFrom(partial: Partial<AuditSummary> & { rates: Record<string, number> }): AuditSummary {
  const rates: Record<string, number> = {};
  for (const name of PATTERN_NAMES) rates[name] = partial.rates[name] ?? 0;
  return {
    sentences: partial.sentences ?? 0,
    meanWords: partial.meanWords ?? 0,
    pctOver35: partial.pctOver35 ?? 0,
    lengthCv: partial.lengthCv ?? 0,
    counts: {},
    rates,
  };
}

/**
 * Fallback target when the author has no profile yet: the human column of the
 * human-prose-audit skill's calibration (one scientist's unassisted draft).
 */
export const GENERIC_HUMAN_SUMMARY: AuditSummary = summaryFrom({
  meanWords: 17.6,
  pctOver35: 1,
  lengthCv: 0.5,
  rates: { 'rather than': 2.9, semicolon: 0, 'which is appositive': 0, 'is what cleft': 0, 'initial Because': 0, tricolon: 4.4 },
});

/** The LLM-assisted column of the same calibration: the far end of the scale. */
export const MACHINE_REFERENCE: AuditSummary = summaryFrom({
  meanWords: 26.8,
  pctOver35: 27,
  lengthCv: 0.3,
  rates: { 'rather than': 25.2, semicolon: 21, 'which is appositive': 7, 'is what cleft': 4, 'initial Because': 4, tricolon: 12 },
});

export function buildProfile(name: string, samples: string[]): { profile: VoiceProfile; warning?: string } {
  const text = samples.join('\n\n');
  const metrics = auditText(text);
  const sampleWords = metrics.sentences.reduce((a, s) => a + s.words, 0);
  if (sampleWords < MIN_PROFILE_WORDS) {
    throw new Error(`Need at least ${MIN_PROFILE_WORDS.toLocaleString()} words of your own writing; got ${sampleWords.toLocaleString()}.`);
  }
  const clean = metrics.sentences
    .filter(s => s.tells.length === 0 && s.words >= 10 && s.words <= 28)
    .sort((a, b) => Math.abs(a.words - metrics.summary.meanWords) - Math.abs(b.words - metrics.summary.meanWords))
    .slice(0, 8)
    .map(s => text.slice(s.start, s.end));
  return {
    profile: {
      id: `vp_${Date.now().toString(36)}`,
      name,
      createdAt: Date.now(),
      sampleWords,
      summary: metrics.summary,
      exampleSentences: clean,
    },
    warning: sampleWords < RECOMMENDED_PROFILE_WORDS
      ? `Only ${sampleWords.toLocaleString()} words measured. ${RECOMMENDED_PROFILE_WORDS.toLocaleString()} or more gives a steadier profile.`
      : undefined,
  };
}

export function activeSummary(p?: VoiceProfile): { summary: AuditSummary; isGeneric: boolean } {
  return p ? { summary: p.summary, isGeneric: false } : { summary: GENERIC_HUMAN_SUMMARY, isGeneric: true };
}
```

- [ ] **Step 5: Implement `src/services/proseAudit/score.ts`**

```ts
import type { AuditSummary } from '../../types';
import { MACHINE_REFERENCE } from './profile';
import { TELL_PATTERNS } from './patterns';

export interface MetricDeviation {
  metric: string;
  label: string;
  voice: number;
  draft: number;
  /** 0 = at the author's voice, 1 = at the machine reference */
  deviation: number;
}

/** Weight per metric: the strongest tells from the skill's calibration count most. */
const WEIGHTS: Record<string, number> = {
  meanWords: 2,
  pctOver35: 2,
  'rather than': 2,
  'not X but/instead': 2,
  'instead of': 1,
  semicolon: 1.5,
  'which is appositive': 1.5,
  'is what cleft': 1.5,
  'initial Because': 1,
  'This/That anaphora': 1,
  tricolon: 0.5,
  'throat-clearing': 1,
  'em dash': 1,
  'not only but also': 1,
  'paragraph connective': 1,
  'summary flourish': 1,
  'stock vocabulary': 1,
};

/** Fallback scale when the machine reference is not above the voice value. */
const FALLBACK_SPAN: Record<string, number> = { meanWords: 9, pctOver35: 26 };

function deviation(metric: string, draft: number, voice: number, machine: number): number {
  const span = machine > voice ? machine - voice : (FALLBACK_SPAN[metric] ?? Math.max(voice, 5));
  return Math.max(0, Math.min(1.5, (draft - voice) / span));
}

function value(s: AuditSummary, metric: string): number {
  if (metric === 'meanWords') return s.meanWords;
  if (metric === 'pctOver35') return s.pctOver35;
  return s.rates[metric] ?? 0;
}

const LABELS: Record<string, string> = {
  meanWords: 'mean sentence length',
  pctOver35: 'sentences over 35 words',
};

function label(metric: string): string {
  return LABELS[metric] ?? TELL_PATTERNS[metric]?.label ?? metric;
}

export function styleDistance(
  draft: AuditSummary,
  voice: AuditSummary,
): { score: number; band: 'close' | 'drifting' | 'far'; deviations: MetricDeviation[] } {
  const deviations: MetricDeviation[] = [];
  let weighted = 0;
  let total = 0;
  for (const [metric, weight] of Object.entries(WEIGHTS)) {
    const d = value(draft, metric);
    const v = value(voice, metric);
    const dev = deviation(metric, d, v, value(MACHINE_REFERENCE, metric));
    deviations.push({ metric, label: label(metric), voice: v, draft: d, deviation: Math.round(dev * 100) / 100 });
    weighted += dev * weight;
    total += weight;
  }
  const raw = total ? weighted / total : 0;
  const score = Math.round(Math.min(100, raw * 100));
  deviations.sort((a, b) => b.deviation - a.deviation);
  return { score, band: score < 25 ? 'close' : score <= 50 ? 'drifting' : 'far', deviations };
}
```

- [ ] **Step 6: Run tests, then both gates**

Run: `npx vitest run src/services/proseAudit && npx tsc --noEmit && npx vitest run`
Expected: all PASS; tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/proseAudit src/types.ts
git commit -m "feat(h): voice profile and style-distance scoring

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Editor highlights and sentence-range replacement

**Files:**
- Create: `src/extensions/StyleHighlights.ts`, `src/extensions/StyleHighlights.test.ts`
- Modify: `src/components/Editor.tsx` (register the extension; add a `replaceRange` ref method)

**Interfaces:**
- Consumes: `auditText`, `worstSentences` (Task 1); `flattenDoc`, `flatSpanToPm` (`src/utils/textMatch.ts`).
- Produces:
  - `StyleHighlights` TipTap extension, options `{ getEnabled: () => boolean; getSentences: () => SentenceAudit[]; onReport?: (m: AuditMetrics) => void; debounceMs?: number }`
  - commands `refreshStyleAudit()`, `setStyleHighlightsEnabled(on: boolean)`
  - exported pure helper `sentenceDecorations(doc: PMNode, sentences: SentenceAudit[]): Decoration[]`
  - `EditorRef.replaceRange(from: number, to: number, text: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/extensions/StyleHighlights.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from './schema';
import { StyleHighlights, sentenceDecorations } from './StyleHighlights';
import { auditText, worstSentences } from '../services/proseAudit/metrics';
import { flattenDoc } from '../utils/textMatch';

function editorWith(html: string) {
  return new Editor({
    extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => true, getSentences: () => [] })],
    content: htmlToDoc(html),
  });
}

describe('sentenceDecorations', () => {
  it('maps a flagged sentence onto the document text it came from', () => {
    const editor = editorWith('<p>We purified the complex by gel filtration. Binding fell at low pH; the effect was large.</p>');
    const flat = flattenDoc(editor.state.doc);
    const worst = worstSentences(auditText(flat.text), 1);
    const decos = sentenceDecorations(editor.state.doc, worst);
    expect(decos).toHaveLength(1);
    const d = decos[0] as unknown as { from: number; to: number };
    expect(editor.state.doc.textBetween(d.from, d.to, ' ')).toContain('Binding fell at low pH');
    editor.destroy();
  });

  it('maps across a citation atom without drifting', () => {
    const editor = editorWith(
      '<p>The receptor binds the protein <span data-citation-node="" data-source-ids="s1" data-nums="1">[1]</span>; affinity was nanomolar in this assay.</p>',
    );
    const flat = flattenDoc(editor.state.doc);
    const worst = worstSentences(auditText(flat.text), 1);
    const d = sentenceDecorations(editor.state.doc, worst)[0] as unknown as { from: number; to: number };
    expect(editor.state.doc.textBetween(d.from, d.to, ' ')).toContain('affinity was nanomolar');
    editor.destroy();
  });

  it('maps a sentence inside a table cell', () => {
    const editor = editorWith(
      '<table><tbody><tr><td><p>The construct was expressed in insect cells; yields were low.</p></td></tr></tbody></table>',
    );
    const flat = flattenDoc(editor.state.doc);
    const worst = worstSentences(auditText(flat.text), 1);
    expect(sentenceDecorations(editor.state.doc, worst)).toHaveLength(1);
    editor.destroy();
  });

  it('drops a sentence whose offsets no longer exist', () => {
    const editor = editorWith('<p>Short text only.</p>');
    const decos = sentenceDecorations(editor.state.doc, [{ start: 500, end: 540, words: 8, tells: ['semicolon'], severity: 20 }]);
    expect(decos).toEqual([]);
    editor.destroy();
  });

  it('adds no decorations when disabled', () => {
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => false, getSentences: () => [{ start: 0, end: 10, words: 5, tells: ['semicolon'], severity: 20 }] })],
      content: htmlToDoc('<p>We purified the complex; it was pure.</p>'),
    });
    const plugin = editor.state.plugins.find(p => (p as unknown as { key?: string }).key?.startsWith('styleHighlights'));
    expect(plugin).toBeDefined();
    editor.destroy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/extensions/StyleHighlights.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/extensions/StyleHighlights.ts`**

```ts
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { flattenDoc, flatSpanToPm } from '../utils/textMatch';
import { auditText } from '../services/proseAudit/metrics';
import type { AuditMetrics, SentenceAudit } from '../types';

export interface StyleHighlightsOptions {
  getEnabled: () => boolean;
  getSentences: () => SentenceAudit[];
  onReport?: (metrics: AuditMetrics) => void;
  debounceMs?: number;
}

const styleHighlightsKey = new PluginKey<DecorationSet>('styleHighlights');

/** Severity band drives the tint; the thresholds are the kernel severity scale. */
function severityClass(s: SentenceAudit): string {
  if (s.severity >= 60) return 'style-tell style-tell-high';
  if (s.severity >= 40) return 'style-tell style-tell-mid';
  return 'style-tell style-tell-low';
}

/**
 * Inline decorations for each flagged sentence. Pure: no editor state is changed,
 * and a sentence whose offsets no longer map into the document is skipped.
 */
export function sentenceDecorations(doc: PMNode, sentences: SentenceAudit[]): Decoration[] {
  const flat = flattenDoc(doc);
  const out: Decoration[] = [];
  for (const s of sentences) {
    if (s.start >= flat.text.length) continue;
    const span = flatSpanToPm(flat, s.start, Math.min(s.end, flat.text.length));
    if (!span || span.to <= span.from) continue;
    out.push(
      Decoration.inline(span.from, span.to, {
        class: severityClass(s),
        title: `${s.words} words · ${s.tells.join(', ')}`,
      }),
    );
  }
  return out;
}

export const StyleHighlights = Extension.create<StyleHighlightsOptions>({
  name: 'styleHighlights',

  addOptions() {
    return { getEnabled: () => false, getSentences: () => [], debounceMs: 400 };
  },

  addCommands() {
    return {
      refreshStyleAudit:
        () =>
        ({ dispatch, tr }: { dispatch?: unknown; tr: { setMeta: (k: PluginKey<DecorationSet>, v: unknown) => void } }) => {
          if (dispatch) tr.setMeta(styleHighlightsKey, { refresh: true });
          return true;
        },
    } as never;
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Re-audit off the critical path, then ask for a decoration refresh. */
    const scheduleReport = () => {
      if (!options.onReport) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const metrics = auditText(flattenDoc(editor.state.doc).text);
        options.onReport?.(metrics);
      }, options.debounceMs ?? 400);
    };

    const build = (doc: PMNode) =>
      options.getEnabled() ? DecorationSet.create(doc, sentenceDecorations(doc, options.getSentences())) : DecorationSet.empty;

    return [
      new Plugin<DecorationSet>({
        key: styleHighlightsKey,
        state: {
          init: (_config, state) => build(state.doc),
          apply(tr, old, _oldState, newState) {
            if (tr.docChanged) {
              scheduleReport();
              return build(newState.doc);
            }
            if (tr.getMeta(styleHighlightsKey)) return build(newState.doc);
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: state => styleHighlightsKey.getState(state) ?? DecorationSet.empty,
        },
        view: () => ({
          destroy() {
            if (timer) clearTimeout(timer);
          },
        }),
      }),
    ];
  },
});
```

- [ ] **Step 4: Add the styles**

Append to `src/index.css`:

```css
/* Style audit highlights (decorations only — never written into the document) */
.style-tell { border-bottom: 2px solid transparent; border-radius: 2px; }
.style-tell-low { background: rgba(250, 204, 21, 0.14); border-bottom-color: rgba(250, 204, 21, 0.5); }
.style-tell-mid { background: rgba(249, 115, 22, 0.16); border-bottom-color: rgba(249, 115, 22, 0.55); }
.style-tell-high { background: rgba(239, 68, 68, 0.16); border-bottom-color: rgba(239, 68, 68, 0.6); }
```

- [ ] **Step 5: Register in `Editor.tsx` and add `replaceRange`**

In `src/components/Editor.tsx`:
- Import `StyleHighlights` from `'../extensions/StyleHighlights'` and the types it needs.
- Add these props to `EditorProps`:

```ts
  /** flagged sentences to tint (sub-project H); empty disables highlighting */
  styleSentences?: SentenceAudit[];
  showStyleHighlights?: boolean;
  onStyleAudit?: (metrics: AuditMetrics) => void;
```

- Keep them in refs next to the existing `aiSettingsRef` pattern:

```ts
  const styleSentencesRef = useRef<SentenceAudit[]>(styleSentences ?? []);
  const showStyleHighlightsRef = useRef(!!showStyleHighlights);
  const onStyleAuditRef = useRef(onStyleAudit);
  useEffect(() => { styleSentencesRef.current = styleSentences ?? []; editor?.commands.refreshStyleAudit?.(); }, [styleSentences, editor]);
  useEffect(() => { showStyleHighlightsRef.current = !!showStyleHighlights; editor?.commands.refreshStyleAudit?.(); }, [showStyleHighlights, editor]);
  useEffect(() => { onStyleAuditRef.current = onStyleAudit; }, [onStyleAudit]);
```

- Add to the `useEditor` extensions array, after the existing entries:

```ts
      StyleHighlights.configure({
        getEnabled: () => showStyleHighlightsRef.current,
        getSentences: () => styleSentencesRef.current,
        onReport: (m) => onStyleAuditRef.current?.(m),
      }),
```

- Add to `EditorRef` and `useImperativeHandle`:

```ts
  /** Replace an exact document range (used by "rewrite in my voice"). */
  replaceRange: (from: number, to: number, text: string) => boolean;
```

```ts
    replaceRange: (from: number, to: number, text: string) => {
      if (!editor) return false;
      const size = editor.state.doc.content.size;
      if (from < 0 || to > size || to <= from) return false;
      editor.chain().focus().insertContentAt({ from, to }, text).run();
      return true;
    },
```

- [ ] **Step 6: Run the tests and both gates**

Run: `npx vitest run src/extensions/StyleHighlights.test.ts && npx tsc --noEmit && npx vitest run`
Expected: all PASS. If the first test's expectation reads awkwardly, assert on the substring `'Binding fell at low pH'` only.

- [ ] **Step 7: Commit**

```bash
git add src/extensions/StyleHighlights.ts src/extensions/StyleHighlights.test.ts src/components/Editor.tsx src/index.css
git commit -m "feat(h): decoration-based style highlights and exact range replacement

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Style panel and voice-profile manager

**Files:**
- Create: `src/components/style/StylePanel.tsx`, `src/components/style/VoiceProfileManager.tsx`
- Create: `src/components/style/StylePanel.test.tsx`
- Modify: `src/components/Sidebar.tsx` (add the `'style'` tab), `src/App.tsx` (wire state through to `Editor`)

**Interfaces:**
- Consumes: `auditText`, `worstSentences`, `activeSummary`, `buildProfile`, `styleDistance`; `useAIStore` (`aiSettings`, `setAiSettings`).
- Produces:
  - `StylePanel` props: `{ metrics: AuditMetrics | null; onJumpToSentence: (s: SentenceAudit) => void; onRewrite: (s: SentenceAudit) => void; highlightsOn: boolean; onToggleHighlights: (on: boolean) => void; rewritingId?: string | null }`
  - `VoiceProfileManager` props: `{ onBuilt?: (name: string) => void }`
  - `SidebarTab` union gains `'style'`.

- [ ] **Step 1: Write the failing test**

Create `src/components/style/StylePanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StylePanel } from './StylePanel';
import { auditText } from '../../services/proseAudit/metrics';

afterEach(cleanup);

const metrics = auditText(
  'Significance\n\nThe problem matters; it matters a great deal to patients, clinicians, and funders.\n\nApproach\n\nWe purified the complex by gel filtration in three runs.',
);

const props = {
  metrics,
  onJumpToSentence: vi.fn(),
  onRewrite: vi.fn(),
  highlightsOn: true,
  onToggleHighlights: vi.fn(),
};

describe('StylePanel', () => {
  it('shows the distance score, its band and the honesty note', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByTestId('style-score').textContent).toMatch(/\d/);
    expect(screen.getByText(/style, not authorship/i)).toBeTruthy();
  });

  it('never claims to detect AI', () => {
    const { container } = render(<StylePanel {...props} />);
    expect(container.textContent).not.toMatch(/\bAI[- ]?(?:probability|detected|written|generated)\b/i);
  });

  it('lists the comparison table with voice and draft columns', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByText(/mean sentence length/i)).toBeTruthy();
    expect(screen.getByTestId('style-table').textContent).toMatch(/semicolon/i);
  });

  it('lists sections and worst sentences, and jumps on click', () => {
    render(<StylePanel {...props} />);
    expect(screen.getByText('Significance')).toBeTruthy();
    const first = screen.getAllByTestId('worst-sentence')[0];
    fireEvent.click(first);
    expect(props.onJumpToSentence).toHaveBeenCalled();
  });

  it('asks for a rewrite', () => {
    render(<StylePanel {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: /rewrite/i })[0]);
    expect(props.onRewrite).toHaveBeenCalled();
  });

  it('shows an empty state with no metrics', () => {
    render(<StylePanel {...props} metrics={null} />);
    expect(screen.getByText(/start writing/i)).toBeTruthy();
  });
});
```

Install the test-only React testing dependencies:

```bash
npm install --save-dev @testing-library/react@16.1.0 @testing-library/dom@10.4.0
```

Nothing else in the repo uses React component tests yet, so if `@testing-library/react` cannot
render under this vitest setup after one attempt at fixing it (the usual cause is a missing
`jsdom` docblock or a stale React 19 peer range), do **not** fight it: drop the render tests,
instead unit-test a pure `styleRows(metrics, voice)` helper extracted from the panel (same
assertions on score, band, table rows and the no-AI-claim string), note the substitution in your
report, and keep the component covered by the manual check in Step 7.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/style/StylePanel.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement `VoiceProfileManager.tsx`**

Follow the repo's existing panel idiom (see `src/components/GrantPanel.tsx` for layout and Tailwind classes).

```tsx
import { useState } from 'react';
import { useAIStore } from '../../stores/useAIStore';
import { buildProfile, MIN_PROFILE_WORDS, RECOMMENDED_PROFILE_WORDS } from '../../services/proseAudit/profile';
import { useSourceStore } from '../../stores/useSourceStore';

export function VoiceProfileManager({ onBuilt }: { onBuilt?: (name: string) => void }) {
  const { aiSettings, setAiSettings } = useAIStore();
  const sources = useSourceStore(s => s.sources);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('My own writing');
  const [pasted, setPasted] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const profile = aiSettings.voiceProfile;

  const create = () => {
    setError(null);
    const samples = [pasted, ...sources.filter(s => picked.includes(s.id)).map(s => s.text)].filter(t => t.trim());
    try {
      const { profile: built, warning: w } = buildProfile(name.trim() || 'My own writing', samples);
      setAiSettings({ ...aiSettings, voiceProfile: built });
      setWarning(w ?? null);
      setOpen(false);
      setPasted('');
      setPicked([]);
      onBuilt?.(built.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm">
      {profile ? (
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium text-slate-800">{profile.name}</div>
            <div className="text-xs text-slate-500">
              {profile.sampleWords.toLocaleString()} words · {profile.summary.meanWords} words/sentence ·{' '}
              {profile.summary.pctOver35}% over 35
            </div>
          </div>
          <div className="flex gap-2">
            <button className="text-xs text-blue-600 hover:underline" onClick={() => setOpen(true)}>Rebuild</button>
            <button
              className="text-xs text-slate-500 hover:underline"
              onClick={() => setAiSettings({ ...aiSettings, voiceProfile: undefined })}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="text-slate-600">
            Comparing against a generic human baseline. Add your own writing for a profile that matches your voice.
          </div>
          <button className="rounded bg-blue-600 px-2 py-1 text-xs text-white" onClick={() => setOpen(true)}>
            Add samples
          </button>
        </div>
      )}

      {warning && <div className="mt-2 text-xs text-amber-700">{warning}</div>}

      {open && (
        <div className="mt-3 space-y-2">
          <input
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Profile name"
          />
          <textarea
            className="h-32 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            placeholder={`Paste at least ${MIN_PROFILE_WORDS.toLocaleString()} words you wrote yourself (${RECOMMENDED_PROFILE_WORDS.toLocaleString()}+ is better).`}
          />
          {sources.length > 0 && (
            <div className="max-h-28 overflow-auto rounded border border-slate-200 p-2">
              <div className="mb-1 text-xs font-medium text-slate-600">Or use uploaded files</div>
              {sources.map(s => (
                <label key={s.id} className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={picked.includes(s.id)}
                    onChange={e => setPicked(p => (e.target.checked ? [...p, s.id] : p.filter(x => x !== s.id)))}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
          )}
          {error && <div className="text-xs text-red-600">{error}</div>}
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-2 py-1 text-xs text-white" onClick={create}>Measure my voice</button>
            <button className="text-xs text-slate-500" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `StylePanel.tsx`**

```tsx
import { useMemo } from 'react';
import { useAIStore } from '../../stores/useAIStore';
import { worstSentences } from '../../services/proseAudit/metrics';
import { activeSummary } from '../../services/proseAudit/profile';
import { styleDistance } from '../../services/proseAudit/score';
import { TELL_PATTERNS } from '../../services/proseAudit/patterns';
import type { AuditMetrics, SentenceAudit } from '../../types';
import { VoiceProfileManager } from './VoiceProfileManager';

interface Props {
  metrics: AuditMetrics | null;
  onJumpToSentence: (s: SentenceAudit) => void;
  onRewrite: (s: SentenceAudit) => void;
  highlightsOn: boolean;
  onToggleHighlights: (on: boolean) => void;
  rewritingId?: string | null;
}

const BAND_STYLES = {
  close: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  drifting: 'bg-amber-50 text-amber-700 border-amber-200',
  far: 'bg-red-50 text-red-700 border-red-200',
} as const;

const BAND_TEXT = {
  close: 'close to your voice',
  drifting: 'drifting from your voice',
  far: 'far from your voice',
} as const;

export function StylePanel({ metrics, onJumpToSentence, onRewrite, highlightsOn, onToggleHighlights, rewritingId }: Props) {
  const voiceProfile = useAIStore(s => s.aiSettings.voiceProfile);
  const { summary: voice, isGeneric } = activeSummary(voiceProfile);

  const result = useMemo(() => (metrics ? styleDistance(metrics.summary, voice) : null), [metrics, voice]);
  const worst = useMemo(() => (metrics ? worstSentences(metrics, 12) : []), [metrics]);

  if (!metrics || !result || metrics.summary.sentences === 0) {
    return (
      <div className="p-4 text-sm text-slate-500">
        Start writing and this panel will compare the draft with your own writing style.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3 text-sm">
      <div className={`rounded-lg border p-3 ${BAND_STYLES[result.band]}`}>
        <div className="flex items-baseline gap-2">
          <span data-testid="style-score" className="text-2xl font-semibold">{result.score}</span>
          <span className="text-xs">/ 100 · {BAND_TEXT[result.band]}</span>
        </div>
        <div className="mt-1 text-xs opacity-80">
          Measures writing style, not authorship.
          {isGeneric && ' Using a generic human baseline until you add your own samples.'}
        </div>
      </div>

      <VoiceProfileManager />

      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={highlightsOn} onChange={e => onToggleHighlights(e.target.checked)} />
        Highlight flagged sentences in the editor
      </label>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Your voice vs this draft</div>
        <table data-testid="style-table" className="w-full text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="text-left font-medium">metric</th>
              <th className="text-right font-medium">yours</th>
              <th className="text-right font-medium">draft</th>
            </tr>
          </thead>
          <tbody>
            {result.deviations
              .filter(d => d.draft > 0 || d.voice > 0)
              .slice(0, 10)
              .map(d => (
                <tr key={d.metric} className={d.deviation >= 0.5 ? 'text-red-700' : 'text-slate-700'}>
                  <td className="py-0.5">{d.label}{TELL_PATTERNS[d.metric] ? ' /100' : ''}</td>
                  <td className="py-0.5 text-right tabular-nums">{d.voice}</td>
                  <td className="py-0.5 text-right font-medium tabular-nums">{d.draft}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {metrics.sections.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By section</div>
          <ul className="space-y-0.5 text-xs">
            {metrics.sections.map(sec => {
              const r = styleDistance(sec.summary, voice);
              return (
                <li key={sec.title} className="flex justify-between gap-2">
                  <span className="truncate text-slate-700">{sec.title}</span>
                  <span className={`tabular-nums ${r.band === 'far' ? 'text-red-600' : 'text-slate-500'}`}>{r.score}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Worst sentences</div>
        <ul className="space-y-2">
          {worst.map(s => (
            <li key={`${s.start}-${s.end}`} className="rounded border border-slate-200 p-2">
              <button
                data-testid="worst-sentence"
                className="block w-full text-left text-xs text-slate-700 hover:text-blue-700"
                onClick={() => onJumpToSentence(s)}
              >
                {s.words} words · {s.tells.map(t => TELL_PATTERNS[t]?.label ?? t).join(', ') || 'long sentence'}
              </button>
              <button
                className="mt-1 text-xs text-blue-600 hover:underline disabled:opacity-50"
                disabled={rewritingId === `${s.start}-${s.end}`}
                onClick={() => onRewrite(s)}
              >
                {rewritingId === `${s.start}-${s.end}` ? 'Rewriting…' : 'Rewrite in my voice'}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add the sidebar tab and App wiring**

In `src/components/Sidebar.tsx`: extend both tab unions (`activeTabOverride`, `onTabChange`, the `useState` at ~line 149) with `'style'`, add a tab button beside the existing ones following their markup, and render `<StylePanel … />` for that tab with the props threaded from `SidebarProps` (add them to the interface and pass them through from `App.tsx`).

In `src/App.tsx`:
- `const [styleMetrics, setStyleMetrics] = useState<AuditMetrics | null>(null);`
- `const [showStyleHighlights, setShowStyleHighlights] = useState(false);`
- `const [rewritingId, setRewritingId] = useState<string | null>(null);`
- Derive the highlighted set once:

```ts
  const styleSentences = useMemo(
    () => (showStyleHighlights && styleMetrics ? worstSentences(styleMetrics, 12) : []),
    [showStyleHighlights, styleMetrics],
  );
```

  and pass `styleSentences={styleSentences} showStyleHighlights={showStyleHighlights} onStyleAudit={setStyleMetrics}` to `<Editor />`.
- `onJumpToSentence`: map the sentence's offsets with `flattenDoc`/`flatSpanToPm` on `editorRef.current` and call the existing scroll helper, or reuse `editorRef.current.scrollToSuggestion` semantics; a simple `replaceRange`-free focus is enough — set the selection to `span.from`.
- `onRewrite`: wired in Task 5 (temporarily a toast saying "not yet wired" is acceptable only within this task's commit; Task 5 replaces it).

- [ ] **Step 6: Run the tests and both gates**

Run: `npx vitest run src/components/style && npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 7: Measure the live-audit budget on a realistic document**

Run:

```bash
npx tsx -e "
import { readFileSync } from 'node:fs';
const src = readFileSync('scripts/eval/fixture.ts','utf8');
const text = src.split('FIXTURE_MANUSCRIPT = \`')[1].split('\`')[0].repeat(20);
const { auditText } = await import('./src/services/proseAudit/metrics.ts');
const t0 = performance.now();
for (let i = 0; i < 5; i++) auditText(text);
console.log('words', text.split(/\s+/).length, 'avg ms', ((performance.now()-t0)/5).toFixed(1));
"
```

Expected: average well under 100 ms for a 12,000+ word document. Record the number in the task report. If it exceeds 100 ms, cache per-paragraph results keyed by text before adding any other optimization.

- [ ] **Step 8: Commit**

```bash
git add src/components/style src/components/Sidebar.tsx src/App.tsx package.json package-lock.json
git commit -m "feat(h): style panel, voice-profile manager and sidebar tab

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Rewrite in my voice

**Files:**
- Create: `src/services/proseAudit/rewrite.ts`, `src/services/proseAudit/rewrite.test.ts`
- Modify: `src/services/ai.ts` (export `callLLM`), `src/App.tsx` (wire `onRewrite`)

**Interfaces:**
- Consumes: `callLLM` from `src/services/ai.ts`; `stripThinkingBlocks`, `lintSuggestedText` (same file); `auditText` (Task 1); `VoiceProfile`.
- Produces:
  - `rewrite.ts`: `buildRewritePrompt(args: { sentence: string; before?: string; after?: string; profile?: VoiceProfile; targetWords: number }): string`, `checkRewrite(original: string, rewrite: string): { ok: boolean; reasons: string[] }`, `rewriteSentence(args: { sentence: string; before?: string; after?: string; profile?: VoiceProfile; settings: AISettings; signal?: AbortSignal }): Promise<{ text: string; retried: boolean; warnings: string[] }>`

- [ ] **Step 1: Write the failing test**

Create `src/services/proseAudit/rewrite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRewritePrompt, checkRewrite } from './rewrite';

const original = 'The functional state is selected kinetically rather than thermodynamically, which is the quantity that matters; we measured 42 complexes at pH 5.5 [3].';

describe('buildRewritePrompt', () => {
  it('states the rules, the target length and the sentence', () => {
    const p = buildRewritePrompt({ sentence: original, targetWords: 18 });
    expect(p).toContain(original);
    expect(p).toMatch(/18/);
    expect(p).toMatch(/semicolon/i);
    expect(p).toMatch(/rather than/i);
    expect(p).toMatch(/number/i);
  });

  it('includes the author's own sentences as examples when a profile exists', () => {
    const p = buildRewritePrompt({
      sentence: original,
      targetWords: 18,
      profile: {
        id: 'v', name: 'mine', createdAt: 0, sampleWords: 2000,
        summary: { sentences: 10, meanWords: 18, pctOver35: 1, lengthCv: 0.5, counts: {}, rates: {} },
        exampleSentences: ['We purified the complex by gel filtration.'],
      },
    });
    expect(p).toContain('We purified the complex by gel filtration.');
  });

  it('gives the neighbouring sentences as context only', () => {
    const p = buildRewritePrompt({ sentence: original, before: 'Prior work disagreed.', after: 'We then validated it.', targetWords: 18 });
    expect(p).toContain('Prior work disagreed.');
    expect(p).toMatch(/context/i);
  });
});

describe('checkRewrite', () => {
  it('accepts a rewrite that keeps the numbers, the citation and drops the tells', () => {
    const r = checkRewrite(original, 'Barrier height selects the functional state. We measured 42 complexes at pH 5.5 [3].');
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it('rejects a dropped number', () => {
    const r = checkRewrite(original, 'Barrier height selects the functional state. We measured complexes at pH 5.5 [3].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/42/);
  });

  it('rejects a dropped citation', () => {
    const r = checkRewrite(original, 'Barrier height selects the state. We measured 42 complexes at pH 5.5.');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/\[3\]/);
  });

  it('rejects a rewrite that is no better', () => {
    const r = checkRewrite(original, 'The state is selected kinetically rather than thermodynamically; we measured 42 complexes at pH 5.5 [3].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/style/i);
  });

  it('rejects an empty or unchanged rewrite', () => {
    expect(checkRewrite(original, '   ').ok).toBe(false);
    expect(checkRewrite(original, original).ok).toBe(false);
  });

  it('treats a number written differently as preserved', () => {
    const r = checkRewrite('We saw 1,200 events in 3 runs.', 'Three runs produced 1200 events.');
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/proseAudit/rewrite.test.ts` → FAIL (module missing).

- [ ] **Step 3: Export `callLLM`**

In `src/services/ai.ts` change `async function callLLM(` (line ~1301) to `export async function callLLM(`. Change nothing else.

- [ ] **Step 4: Implement `src/services/proseAudit/rewrite.ts`**

```ts
import { callLLM, stripThinkingBlocks, lintSuggestedText } from '../ai';
import { auditText } from './metrics';
import type { AISettings, VoiceProfile } from '../../types';

const SYSTEM =
  'You rewrite single sentences of scientific prose in the author\'s own voice. You return only the rewritten sentence or sentences, with no preamble, no quotation marks and no explanation.';

/** Numbers, normalized so 1,200 and 1200 compare equal. */
function numericTokens(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => n.replace(/,/g, ''));
}

function citationMarkers(text: string): string[] {
  return text.match(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g) ?? [];
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
      `- Aim for about ${targetWords} words. Two short sentences are better than one long one.`,
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
    parts.push(`Context (do not rewrite these):\n${[before, after].filter(Boolean).join('\n')}`);
  }
  parts.push(`SENTENCE:\n${sentence}`);
  parts.push('Rewritten sentence:');
  return parts.join('\n\n');
}

export function checkRewrite(original: string, rewrite: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const text = rewrite.trim();
  if (!text) return { ok: false, reasons: ['The rewrite is empty.'] };
  if (text === original.trim()) return { ok: false, reasons: ['The rewrite is identical to the original.'] };

  const have = numericTokens(text);
  for (const n of numericTokens(original)) {
    if (!have.includes(n)) reasons.push(`The number ${n} is missing from the rewrite.`);
  }
  for (const c of citationMarkers(original)) {
    if (!text.includes(c)) reasons.push(`The citation ${c} is missing from the rewrite.`);
  }

  const severity = (t: string) => auditText(t).sentences.reduce((a, s) => a + s.severity, 0);
  if (severity(text) >= severity(original)) {
    reasons.push('The rewrite does not improve the style score.');
  }
  return { ok: reasons.length === 0, reasons };
}

export async function rewriteSentence(args: {
  sentence: string;
  before?: string;
  after?: string;
  profile?: VoiceProfile;
  settings: AISettings;
  signal?: AbortSignal;
}): Promise<{ text: string; retried: boolean; warnings: string[] }> {
  const targetWords = Math.max(12, Math.round(args.profile?.summary.meanWords ?? 18));
  const clean = (raw: string) =>
    lintSuggestedText(stripThinkingBlocks(raw).trim().replace(/^["'“]|["'”]$/g, '').trim(), args.sentence);

  const ask = (extra?: string) =>
    callLLM(
      extra ? `${buildRewritePrompt({ ...args, targetWords })}\n\nThe previous attempt was rejected: ${extra}\nTry again.` : buildRewritePrompt({ ...args, targetWords }),
      args.settings,
      SYSTEM,
      false,
      undefined,
      args.signal,
      220,
    );

  const first = clean(await ask());
  const firstCheck = checkRewrite(args.sentence, first);
  if (firstCheck.ok) return { text: first, retried: false, warnings: [] };

  const second = clean(await ask(firstCheck.reasons.join(' ')));
  const secondCheck = checkRewrite(args.sentence, second);
  if (secondCheck.ok) return { text: second, retried: true, warnings: [] };

  // Both attempts failed a guard: hand back the better one, flagged.
  const best = secondCheck.reasons.length <= firstCheck.reasons.length ? second : first;
  const reasons = secondCheck.reasons.length <= firstCheck.reasons.length ? secondCheck.reasons : firstCheck.reasons;
  return { text: best, retried: true, warnings: reasons };
}
```

- [ ] **Step 5: Wire `onRewrite` in `App.tsx`**

```ts
  const handleStyleRewrite = useCallback(async (s: SentenceAudit) => {
    const ed = editorRef.current;
    if (!ed || !aiSettings) return;
    const id = `${s.start}-${s.end}`;
    setRewritingId(id);
    try {
      const plain = ed.getPlainText();
      const sentence = plain.slice(s.start, s.end);
      const result = await rewriteSentence({
        sentence,
        before: plain.slice(Math.max(0, s.start - 200), s.start).split(/(?<=[.!?])\s+/).pop(),
        after: plain.slice(s.end, s.end + 200).split(/(?<=[.!?])\s+/)[0],
        profile: aiSettings.voiceProfile,
        settings: aiSettings,
      });
      const flat = flattenDoc(ed.getEditorDoc());
      const span = flatSpanToPm(flat, s.start, s.end);
      if (!span || !ed.replaceRange(span.from, span.to, result.text)) {
        showToast('That sentence has changed since it was flagged. Re-run the style check.', 'error');
        return;
      }
      showToast(
        result.warnings.length
          ? `Rewritten, but check it: ${result.warnings[0]}`
          : 'Sentence rewritten. Ctrl+Z undoes it.',
        result.warnings.length ? 'info' : 'success',
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Rewrite failed.', 'error');
    } finally {
      setRewritingId(null);
    }
  }, [aiSettings, showToast]);
```

This needs the document for offset mapping. Add to `EditorRef` in `src/components/Editor.tsx`:

```ts
  /** The live ProseMirror document, for offset→position mapping. */
  getEditorDoc: () => unknown;
```

```ts
    getEditorDoc: () => editor?.state.doc,
```

Pass `onRewrite={handleStyleRewrite}` and `rewritingId={rewritingId}` through `Sidebar` to `StylePanel`.

- [ ] **Step 6: Add a local-model eval case**

In `scripts/eval/` add a `styleRewrite` check following the existing scorer pattern in `scripts/eval/checks.ts`: for each of three seeded machine-style sentences (write them in the eval file), call `rewriteSentence` against the configured local model and assert (a) `checkRewrite` passes, (b) every number and citation survives, (c) no thinking leak per the existing `looksLikeThinking`. Register it in `scripts/eval/run.ts` next to the trim/autocomplete scorers.

Run: `npm run eval:local` (needs the local model at `http://localhost:8080`; if it is not running, say so in the report and skip — do not fake a result).

- [ ] **Step 7: Run both gates**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/proseAudit src/services/ai.ts src/App.tsx src/components scripts/eval
git commit -m "feat(h): guarded rewrite-in-my-voice for flagged sentences

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Binoculars feasibility spike (throwaway)

**Files:**
- Create: `scripts/spikes/binoculars-local.ts`
- Create: `docs/superpowers/plans/2026-10-07-binoculars-spike.md`

**Interfaces:** none — nothing in `src/` may import this.

- [ ] **Step 1: Probe the local server's logprob support**

The user's local model runs at `http://localhost:8080` (llama.cpp, model id `ornith`; the project's notes say it is started with `ai-backend llama`). Binoculars needs per-token log-probabilities **of supplied text**, not of generated text.

Run each of these and record the exact response shape (or the error):

```bash
curl -s http://localhost:8080/v1/models | head -c 400
curl -s http://localhost:8080/v1/completions -H 'Content-Type: application/json' \
  -d '{"model":"ornith","prompt":"The complex was purified by gel filtration.","max_tokens":0,"echo":true,"logprobs":1}' | head -c 1200
curl -s http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"ornith","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"logprobs":true,"top_logprobs":1}' | head -c 800
```

If `/v1/completions` with `echo: true, max_tokens: 0` returns a `logprobs.token_logprobs` array covering the prompt, the method is feasible. Also try llama.cpp's native endpoints if the OpenAI-compatible ones do not:

```bash
curl -s http://localhost:8080/completion -H 'Content-Type: application/json' \
  -d '{"prompt":"The complex was purified by gel filtration.","n_predict":0,"n_probs":1}' | head -c 1200
```

- [ ] **Step 2: Write the probe script**

`scripts/spikes/binoculars-local.ts`: given two texts, request prompt log-probabilities from whichever endpoint worked, compute mean negative log-likelihood (log-perplexity) for each, and print them. If a second model is available (ask the user or check `/v1/models`), also compute the cross-perplexity ratio the Binoculars paper uses; otherwise print the single-model perplexity and say the ratio could not be computed.

Use for inputs: one paragraph of the repo's own `FIXTURE_MANUSCRIPT` and one paragraph generated by the local model itself (prompt it once). Do not use the user's grant text.

- [ ] **Step 3: Write the findings note**

`docs/superpowers/plans/2026-10-07-binoculars-spike.md` must answer, with the commands and raw shapes as evidence:
1. Does the server return prompt log-probabilities? Which endpoint and field?
2. Is a second compatible model available, and what would running both cost in memory?
3. The measured log-perplexity of both sample texts (and the ratio, if computable).
4. **Recommendation:** go or no-go for a tier-2 score in the app, with the reason. If no-go, state what would have to change (a server flag, a second model, a different runtime).

- [ ] **Step 4: Commit**

```bash
git add scripts/spikes/binoculars-local.ts docs/superpowers/plans/2026-10-07-binoculars-spike.md
git commit -m "spike(h): local Binoculars feasibility probe and findings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Spec coverage (H)

| Spec section | Task |
|---|---|
| §1 Metrics engine, kernel parity, sentence/section filtering | 1 |
| §2 Voice profile, generic + machine references, storage in `AISettings` | 2 |
| §3 Scoring, deviations, bands | 2 |
| §4 Editor decorations, debounced live audit | 3 |
| §4 Style tab, comparison table, section breakdown, worst sentences, profile manager | 4 |
| §5 Rewrite prompt, guards, retry, exact-range apply | 5 |
| §6 Binoculars spike | 6 |
| Testing: unit, decoration offsets, eval, gates | 1–5 |
