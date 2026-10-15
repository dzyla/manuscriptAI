# R2: Review engine, anchors and findings store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the review half of the old agent crew with a checklist-driven engine that asks one question at a time, anchors every finding to a quote inside a named section, and stores findings so a re-run replaces them without losing what the author dismissed.

**Architecture:** `src/services/review/` gains four pure modules (`anchor.ts`, `findings.ts`, `excerpts.ts`, and a per-check renderer in the existing `prompt.ts`) and one orchestrator (`engine.ts`). The orchestrator is the only part that talks to the network, through the existing `callLLM` in `ai.ts`; everything it does to a response — validation, mapping, dedupe, anchoring — is a pure function that vitest drives without a network. Findings persist in Dexie v7 (`reviewRuns`, `findings`, plus `reviewDismissals` on the document row) and reach the UI through the existing Review panel, which keeps showing the old `Suggestion` cards for edits until R4 removes them.

**Tech Stack:** TypeScript, React 19, Zustand, Dexie 4 (IndexedDB), ProseMirror/TipTap, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-review-v2-design.md` (§2 findings and anchors, §3.1–3.6 the review pass, §6 gates, §7 testing, §8 build order). The spike the engine's prompt shape comes from: `docs/superpowers/specs/2026-10-10-review-prompting-spike.md`.

## Measured before planning (2026-10-14)

The engine design below is not a proposal. It was run end to end before this plan was written, built **only from
committed product code** — `checklist.ts` + `checklistProcedures.ts` for the questions, `sections.ts` for the section
map, `crossChecks.ts` for the detectors — with the per-check prompt and the retrieval in Task 3 and Task 4 copied
verbatim out of that probe. Model: Qwen3.8-27B-UD-IQ2_M (2-bit, local, llama.cpp on :8090), temperature 0, three
concurrent calls. Documents: the two synthetic eval fixtures plus the author's three real grants, each mutated blind
by a separate agent. The real grants and their mutations stay outside the repo at `~/review-eval-private/`.

| Document | Tokens | Checks asked | Plants found by the LLM | With detectors | Trap false alarms | Calls | Wall |
|---|---|---|---|---|---|---|---|
| synthetic grant | 2.3k | 28 | 14/15 | 14/15 | 0 | 28 | 132s |
| synthetic manuscript | 0.4k | 20 | 10/12 | 10/12 | 0 | 20 | 59s |
| Michelson (real) | 1.5k | 28 | 5/5 | 5/5 | **2** | 28 | 86s |
| SNSF (real) | 8.7k | 25 | 6/7 | 6/7 | 0 | 25 | 124s |
| R01 (real) | 25.4k | 28 | 2/9 | 6/9 | 0 | 28 | 163s |
| **total** | | | **37/48** | **41/48 (85%)** | **2** | 129 | 9m |

What this says, and what it does not:

- **It reproduces the spike exactly** (37 → 41 of 48), from product code rather than scratchpad code. The spike's
  numbers are not an artefact of how the spike built its prompts.
- **The local tier already clears the cloud gate** on the synthetic grant: 14/15 is 93% against a gate of 80%, with
  no false alarm, on a 2-bit local model. The R1 local baseline on the same fixture was 8/15 with 3 false alarms.
- **The R01 ceiling of 6/9 is confirmed**, with detectors contributing 4 of the 6. The three that still escape are
  single deleted or weakened sentences. R2 reports this number and sets no long-document recall gate, as §6 says.
- **The two false alarms are both on the Michelson extract, which has no headings at all** — one section of kind
  `any`, so every check is asked against the whole text with no section to locate an answer in. This is spec §9's
  "section keys from headings" risk, measured: a headingless document costs precision, not recall (5/5 plants).
  It is not a defect to fix in R2; it is a reason the card must not claim a section it does not know.
- **A first run of the R01 scored 0/9 from the LLM** because every prompt overflowed the model's per-slot context
  (6,144 tokens), and the excerpt budget is what caused it. See the note in Task 4: the budget must be derived from
  the context window, not hardcoded. This is the single most useful thing the measurement found.

The probe harness is throwaway and stays in the session scratchpad (`r2probe/probe.ts`); the code worth keeping is
in Tasks 3 and 4 of this plan.

## Global Constraints

- The gate for this milestone is three exit codes, all 0: `npx tsc --noEmit`, `npx vitest run`, `npm run build`. Then revert `dist-electron/` churn (`git checkout -- dist-electron`).
- Never change `vitest.config.ts`. `maxForks: 2` is deliberate — one worker per core exhausts this machine's RAM.
- `npm run lint` is unreliable in this environment. The authoritative type-check is `npx tsc --noEmit`.
- Do not start a dev server or a browser as part of a task.
- No test may make a network call. Pipeline tests drive the engine through a fake `callLLM`.
- No editor schema change anywhere in R2. A node or mark attribute change would silently switch off the DOCX preservation layer (`src/docx/preserve/hash.test.ts` golden hashes).
- Severity comes from the check (`ReviewCheck.severity`), never from the model.
- On the wire `quote` is always a string; `""` means a missing-content finding and the mapper turns it into `null`. Not every provider's constrained decoding accepts a nullable type.
- API keys come from environment variables only; never printed, never written to a file.
- Checklist content is frozen in R2: do not add, remove or reword a check, a procedure step or an example. R2 consumes `CHECKS` as it stands.
- Every new user-visible control gets a literal `data-testid="control-x"` and a row in `src/components/shell/reachability.test.tsx`. The guards do not see a `<select>`, a checkbox, a `<div onClick>` or a templated test id, so those rows are written by hand.

## Review Focus

Five input classes the spec implies that no task's happy path exercises. Each one's test is pinned to the task that owns the code.

1. **A model names a section key that exists but whose body is empty, or a `checkId` from another document type.** Validation must drop it and count the drop, not anchor the finding to the document start. (Task 2.)
2. **The same quote appears twice inside one section.** `occurrence` is the only thing that separates the two findings; an off-by-one here silently highlights the wrong sentence. (Task 1.)
3. **The author edits the document while a review is running, then the run finishes.** Anchors resolve against the document as it is at display time, so a quote that has since been deleted must render as "text changed" with Dismiss only, never throw. (Tasks 1 and 8.)
4. **Stop pressed between the detector pass and the first LLM response.** The run must persist as `stopped` with the detector findings kept, and no unhandled rejection — vitest exits 1 on an unhandled rejection in a pending timer even when every test passes. (Task 5.)
5. **A document with no headings at all** (a pasted draft). Every section key is `document`, so the schema enum has one member and `resolveAnchor` has no heading to fall back to. Findings must still anchor by quote. (Tasks 1, 3 and 5.)

---
## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/services/review/anchor.ts` | `resolveAnchor`, `fingerprint`. The only code that searches the document for a finding's text. |
| `src/services/review/findings.ts` | `Finding`/`FindingAnchor` types, response→`Finding` mapping with validation counts, dedupe, dismissal filtering. |
| `src/services/review/excerpts.ts` | `outline`, `retrieve`: the deterministic search that picks the paragraphs one check sees. |
| `src/services/review/engine.ts` | `runReview`: tier selection, call loop, abort, progress, verify, detector merge. The only module here that touches the network. |
| `src/db/reviewRepository.ts` | Dexie reads and writes for runs, findings and dismissals. |
| `src/stores/useReviewStore.ts` | Findings in memory for the UI; thin, like `useAIStore`. |
| `src/components/panels/review/FindingCard.tsx` | One finding, with Locate / Dismiss. |
| `src/components/panels/review/FindingList.tsx` | Document-ordered list of findings plus the run header. |
| `scripts/eval/review/v2.ts` | Eval adapter: drives `runReview` and returns the existing `SystemOutput`. |

**Modified**

| File | Change |
|---|---|
| `src/services/review/prompt.ts` | Add `renderCheckPrompt` and `checkSchema`; keep `renderRolePrompt` for the cloud tier. |
| `src/db/manuscriptDb.ts` | Version 7: `reviewRuns`, `findings`. |
| `src/types.ts` | `reviewDismissals?: string[]` on the document row type; `localContextTokens?: number` and `reviewEachAim?: boolean` on `AISettings`. |
| `src/hooks/useAnalysis.ts` | `handleAnalyze` calls `runReview` for the review pass; Stop and progress carry through. |
| `src/components/panels/ReviewPanel.tsx` | Render findings above the legacy suggestion list. |
| `src/services/detectors.ts` | Map each detector to a check id; teach the citation regex grouped and ranged citations. |
| `scripts/eval/review/run.ts` | `--system v2` alongside the baseline; report the new counters. |
| `src/components/shell/reachability.test.tsx` | Rows for the new controls. |

Each module is a file a reviewer can hold in one screen. `engine.ts` is the one with any size to it, and it stays under ~250 lines because every decision it makes is a pure function imported from a neighbour.

---

### Task 1: `resolveAnchor` and `fingerprint`

The resolver is first because every later task calls it. It is the only code in R2 that searches the document.

**Files:**
- Create: `src/services/review/anchor.ts`
- Test: `src/services/review/anchor.test.ts`

**Interfaces:**
- Consumes: `sectionMap(doc, docType) → Section[]` from `./sections`; `flattenDoc`, `flatSpanToPm`, `findTextSpan`, `normalizeForMatch` from `../../utils/textMatch`.
- Produces:
  ```ts
  export interface FindingAnchor { sectionKey: string; quote: string | null; occurrence: number }
  export type AnchorResult =
    | { kind: 'quote'; from: number; to: number; moved: boolean }
    | { kind: 'heading'; from: number; to: number; moved: boolean }
    | { kind: 'lost' };
  export function resolveAnchor(doc: PMNode, docType: DocType, anchor: FindingAnchor): AnchorResult;
  export function fingerprint(checkId: string, anchor: FindingAnchor): string;
  ```
  `moved: true` means the section key did not resolve and the quote was found elsewhere in the document. `kind: 'lost'` means the quote is gone — the card offers Dismiss only.

- [ ] **Step 1: Write the failing test for the occurrence rule**

`src/services/review/anchor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { resolveAnchor, fingerprint } from './anchor';

/** A document of (heading, paragraph…) pairs, built through the real editor schema. */
function docOf(blocks: { heading?: string; level?: number; paras: string[] }[]) {
  const content: any[] = [];
  for (const b of blocks) {
    if (b.heading !== undefined) {
      content.push({ type: 'heading', attrs: { level: b.level ?? 1 }, content: [{ type: 'text', text: b.heading }] });
    }
    for (const p of b.paras) content.push({ type: 'paragraph', content: [{ type: 'text', text: p }] });
  }
  return getSpecSchema().nodeFromJSON({ type: 'doc', content });
}

const AIMS = 'Specific Aims';

describe('resolveAnchor', () => {
  it('picks the occurrence-th match of a quote inside its own section', () => {
    const doc = docOf([
      { heading: AIMS, paras: ['We will measure the response.', 'We will measure the response.'] },
    ]);
    const first = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: 'measure the response', occurrence: 0 });
    const second = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: 'measure the response', occurrence: 1 });
    expect(first.kind).toBe('quote');
    expect(second.kind).toBe('quote');
    expect((second as any).from).toBeGreaterThan((first as any).from);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/review/anchor.test.ts`
Expected: FAIL — `Failed to resolve import "./anchor"`.

- [ ] **Step 3: Write `anchor.ts`**

```ts
/**
 * The one resolver. A finding carries a section key, a quote and which occurrence of that quote it means;
 * everything that needs document positions (highlight decorations, Locate, Insert note, Accept) comes here.
 * Nothing else searches the document for a finding's text.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { sectionMap } from './sections';
import type { DocType, Section } from './types';
import { findTextSpan, flatSpanToPm, flattenDoc, normalizeForMatch } from '../../utils/textMatch';

export interface FindingAnchor {
  sectionKey: string;
  /** null = the finding is that something is MISSING; it anchors to the section heading. */
  quote: string | null;
  /** Which match of `quote` inside the section, 0-based. */
  occurrence: number;
}

export type AnchorResult =
  | { kind: 'quote'; from: number; to: number; moved: boolean }
  | { kind: 'heading'; from: number; to: number; moved: boolean }
  | { kind: 'lost' };

/** Flat-text offsets of a section's body, so a quote search stays inside it. */
function flatRange(flat: ReturnType<typeof flattenDoc>, section: Section): { lo: number; hi: number } {
  let lo = flat.text.length;
  let hi = 0;
  for (const seg of flat.segments) {
    if (seg.pmPos < section.headingTo || seg.pmPos >= section.to) continue;
    lo = Math.min(lo, seg.flatStart);
    hi = Math.max(hi, seg.flatStart + seg.flatLen);
  }
  return lo <= hi ? { lo, hi } : { lo: 0, hi: 0 };
}

/** The `occurrence`-th match of `quote` in `hay`, searched with the shared normalisation. */
function nthMatch(hay: string, quote: string, occurrence: number): { start: number; end: number } | null {
  let offset = 0;
  for (let i = 0; i <= occurrence; i++) {
    const hit = findTextSpan(hay.slice(offset), quote);
    if (!hit) return null;
    const start = offset + hit.start;
    const end = offset + hit.end;
    if (i === occurrence) return { start, end };
    offset = start + Math.max(1, hit.end - hit.start);
    if (offset >= hay.length) return null;
  }
  return null;
}

export function resolveAnchor(doc: PMNode, docType: DocType, anchor: FindingAnchor): AnchorResult {
  const sections = sectionMap(doc, docType);
  const flat = flattenDoc(doc);
  const section = sections.find(s => s.key === anchor.sectionKey);

  if (anchor.quote === null) {
    if (!section) return { kind: 'lost' };
    const from = section.headingFrom;
    const to = section.headingTo > section.headingFrom ? section.headingTo : Math.min(section.to, section.from + 1);
    return { kind: 'heading', from, to, moved: false };
  }

  if (section) {
    const { lo, hi } = flatRange(flat, section);
    const hit = hi > lo ? nthMatch(flat.text.slice(lo, hi), anchor.quote, anchor.occurrence) : null;
    if (hit) {
      const span = flatSpanToPm(flat, lo + hit.start, lo + hit.end);
      if (span) return { kind: 'quote', ...span, moved: false };
    }
  }

  // The heading was renamed or deleted, or the text moved: search the whole document once.
  const whole = nthMatch(flat.text, anchor.quote, 0);
  if (whole) {
    const span = flatSpanToPm(flat, whole.start, whole.end);
    if (span) return { kind: 'quote', ...span, moved: true };
  }
  return { kind: 'lost' };
}

/** Identity of a finding for dedupe and dismissal: the check, where it is, and what it quotes. */
export function fingerprint(checkId: string, anchor: FindingAnchor): string {
  const q = anchor.quote === null ? '' : normalizeForMatch(anchor.quote).text.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${checkId}|${anchor.sectionKey}|${q}`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/services/review/anchor.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the rest of the resolver's tests**

Append to `anchor.test.ts`, inside the same `describe`:

```ts
  it('finds the right section when the same quote appears in two sections', () => {
    const doc = docOf([
      { heading: AIMS, paras: ['The design is powered at 80%.'] },
      { heading: 'Approach', paras: ['The design is powered at 80%.'] },
    ]);
    const inAims = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: 'powered at 80%', occurrence: 0 });
    const inApproach = resolveAnchor(doc, 'grant', { sectionKey: 'approach#0', quote: 'powered at 80%', occurrence: 0 });
    expect(inAims.kind).toBe('quote');
    expect(inApproach.kind).toBe('quote');
    expect((inApproach as any).from).toBeGreaterThan((inAims as any).from);
    expect((inAims as any).moved).toBe(false);
  });

  it('anchors a missing-content finding to the heading', () => {
    const doc = docOf([{ heading: AIMS, paras: ['We will measure the response.'] }]);
    const r = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: null, occurrence: 0 });
    expect(r.kind).toBe('heading');
    expect((r as any).to).toBeGreaterThan((r as any).from);
  });

  it('reports moved when the heading was renamed but the quote survives', () => {
    const doc = docOf([{ heading: 'Aims and objectives', paras: ['We will measure the response.'] }]);
    const r = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: 'measure the response', occurrence: 0 });
    expect(r.kind).toBe('quote');
    expect((r as any).moved).toBe(true);
  });

  it('reports lost when the quoted text is gone', () => {
    const doc = docOf([{ heading: AIMS, paras: ['We will do something else entirely.'] }]);
    const r = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: 'measure the response', occurrence: 0 });
    expect(r).toEqual({ kind: 'lost' });
  });

  it('reports lost for a missing-content finding whose section is gone', () => {
    const doc = docOf([{ heading: 'Approach', paras: ['Text.'] }]);
    const r = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: null, occurrence: 0 });
    expect(r).toEqual({ kind: 'lost' });
  });

  it('anchors by quote in a document with no headings', () => {
    const doc = docOf([{ paras: ['We will measure the response in sixty animals.'] }]);
    const r = resolveAnchor(doc, 'grant', { sectionKey: 'document', quote: 'sixty animals', occurrence: 0 });
    expect(r.kind).toBe('quote');
    expect((r as any).moved).toBe(false);
  });

  it('tolerates a quote whose punctuation the model changed', () => {
    const doc = docOf([{ heading: AIMS, paras: ['We will measure the “response” in sixty animals.'] }]);
    const r = resolveAnchor(doc, 'grant', { sectionKey: 'specific-aims#0', quote: 'measure the "response"', occurrence: 0 });
    expect(r.kind).toBe('quote');
  });
});

describe('fingerprint', () => {
  it('ignores quote case, punctuation and run-length whitespace', () => {
    const a = fingerprint('g-rig-power', { sectionKey: 'approach#0', quote: 'Powered  at 80%', occurrence: 0 });
    const b = fingerprint('g-rig-power', { sectionKey: 'approach#0', quote: 'powered at 80%', occurrence: 3 });
    expect(a).toBe(b);
  });

  it('separates a missing-content finding from a quoted one', () => {
    const missing = fingerprint('g-rig-power', { sectionKey: 'approach#0', quote: null, occurrence: 0 });
    const quoted = fingerprint('g-rig-power', { sectionKey: 'approach#0', quote: 'powered at 80%', occurrence: 0 });
    expect(missing).not.toBe(quoted);
  });
});
```

Note the deliberate shape of `fingerprint`: occurrence is **not** part of it. Two findings of the same check quoting the same sentence in the same section are the same finding however many times that sentence appears.

- [ ] **Step 6: Run the whole file and fix what fails**

Run: `npx vitest run src/services/review/anchor.test.ts`
Expected: PASS, 9 tests. The likely failure is the section-key spelling in the tests: `sectionMap` builds keys by slugifying the heading path, so check what it actually returns for "Specific Aims" (`npx tsx -e "..."` or a `console.log` in the test) and use that, rather than changing `slugify`.

- [ ] **Step 7: Commit**

```bash
git add src/services/review/anchor.ts src/services/review/anchor.test.ts
git commit -m "feat(review): one anchor resolver for findings"
```

---
### Task 2: `Finding`, response mapping and dedupe

Everything that turns a model's JSON into findings lives here, and none of it touches the network. This is where a bad response is made harmless.

**Files:**
- Create: `src/services/review/findings.ts`
- Test: `src/services/review/findings.test.ts`

**Interfaces:**
- Consumes: `fingerprint`, `FindingAnchor` from `./anchor`; `checkById` from `./checklist`; `CrossFinding` from `./crossChecks`.
- Produces:
  ```ts
  export interface Finding {
    id: string; runId: string; checkId: string;
    agent: ReviewerRole | 'detector';
    anchor: FindingAnchor;
    issue: string; recommendation: string; severity: Severity;
    verification: 'verified' | 'unverified';
    status: 'open' | 'dismissed' | 'noted';
  }
  export interface MapCounts { droppedCheckId: number; droppedSectionKey: number; droppedEmpty: number }
  export interface RawProblem { sectionKey?: unknown; quote?: unknown; issue?: unknown; recommendation?: unknown; checkId?: unknown; severity?: unknown }
  export function mapProblems(raw: unknown, opts: MapOptions): { findings: Finding[]; counts: MapCounts };
  export function fromCrossFindings(cross: CrossFinding[], runId: string): Finding[];
  export function dedupeFindings(findings: Finding[]): Finding[];
  export function dropDismissed(findings: Finding[], dismissed: readonly string[]): Finding[];
  ```
  `MapOptions` is `{ runId: string; checkId?: string; agent: ReviewerRole | 'detector'; sectionKeys: readonly string[]; checkIds: readonly string[]; sectionText: (key: string) => string }`. `checkId` is set for a per-check call (the model is not asked for it); for a role-batched call it is absent and the model's `checkId` is validated against `checkIds`.

- [ ] **Step 1: Write the failing tests**

`src/services/review/findings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dedupeFindings, dropDismissed, fromCrossFindings, mapProblems } from './findings';
import { fingerprint } from './anchor';

const SECTIONS: Record<string, string> = {
  'approach#0': 'We will enrol sixty animals. We will enrol sixty animals in the second cohort.',
  'specific-aims#0': 'Aim 1 tests the hypothesis.',
};

const opts = (over: Partial<Parameters<typeof mapProblems>[1]> = {}) => ({
  runId: 'run-1',
  checkId: 'g-rig-power',
  agent: 'statistician' as const,
  sectionKeys: Object.keys(SECTIONS),
  checkIds: ['g-rig-power', 'g-rig-design'],
  sectionText: (k: string) => SECTIONS[k] ?? '',
  ...over,
});

describe('mapProblems', () => {
  it('maps a problem to a finding with the check severity, not the model severity', () => {
    const { findings } = mapProblems(
      { problems: [{ sectionKey: 'approach#0', quote: 'sixty animals', issue: 'No power analysis.', recommendation: 'Add one.', severity: 'minor' }] },
      opts(),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe('g-rig-power');
    expect(findings[0].anchor).toEqual({ sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 });
    expect(findings[0].severity).toBe('major'); // g-rig-power's own default
    expect(findings[0].status).toBe('open');
    expect(findings[0].verification).toBe('unverified');
  });

  it('turns an empty quote into a missing-content anchor', () => {
    const { findings } = mapProblems(
      { problems: [{ sectionKey: 'approach#0', quote: '', issue: 'No power analysis anywhere.', recommendation: 'Add one.' }] },
      opts(),
    );
    expect(findings[0].anchor.quote).toBeNull();
  });

  it('counts the occurrence when the quote repeats inside its section', () => {
    const { findings } = mapProblems(
      { problems: [
        { sectionKey: 'approach#0', quote: 'We will enrol sixty animals', issue: 'a', recommendation: 'b' },
        { sectionKey: 'approach#0', quote: 'We will enrol sixty animals in the second cohort', issue: 'c', recommendation: 'd' },
      ] },
      opts(),
    );
    expect(findings.map(f => f.anchor.occurrence)).toEqual([0, 0]);
  });

  it('drops a section key that is not offered and counts it', () => {
    const { findings, counts } = mapProblems(
      { problems: [{ sectionKey: 'innovation#0', quote: 'x', issue: 'a', recommendation: 'b' }] },
      opts(),
    );
    expect(findings).toHaveLength(0);
    expect(counts.droppedSectionKey).toBe(1);
  });

  it('drops an unknown checkId on a role-batched response and counts it', () => {
    const { findings, counts } = mapProblems(
      { findings: [{ checkId: 'g-made-up', sectionKey: 'approach#0', quote: 'sixty animals', issue: 'a', recommendation: 'b', severity: 'major' }] },
      opts({ checkId: undefined }),
    );
    expect(findings).toHaveLength(0);
    expect(counts.droppedCheckId).toBe(1);
  });

  it('drops a problem with no issue text and counts it', () => {
    const { findings, counts } = mapProblems(
      { problems: [{ sectionKey: 'approach#0', quote: 'sixty animals', issue: '   ', recommendation: '' }] },
      opts(),
    );
    expect(findings).toHaveLength(0);
    expect(counts.droppedEmpty).toBe(1);
  });

  it('survives a response that is not the shape asked for', () => {
    for (const raw of [null, undefined, 'nope', 42, {}, { problems: 'no' }, { problems: [null, 7] }]) {
      expect(() => mapProblems(raw, opts())).not.toThrow();
      expect(mapProblems(raw, opts()).findings).toEqual([]);
    }
  });
});

describe('dedupeFindings', () => {
  const base = { runId: 'r', agent: 'statistician' as const, issue: 'i', severity: 'major' as const, verification: 'unverified' as const, status: 'open' as const };

  it('merges equal fingerprints and keeps the longer recommendation', () => {
    const a = { ...base, id: '1', checkId: 'g-rig-power', anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 }, recommendation: 'Add power.' };
    const b = { ...base, id: '2', checkId: 'g-rig-power', anchor: { sectionKey: 'approach#0', quote: 'Sixty  animals', occurrence: 0 }, recommendation: 'Add a power analysis for each aim.' };
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].recommendation).toBe('Add a power analysis for each aim.');
  });

  it('keeps two findings of DIFFERENT checks that quote the same text', () => {
    const a = { ...base, id: '1', checkId: 'g-rig-power', anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 }, recommendation: 'x' };
    const b = { ...base, id: '2', checkId: 'g-rig-design', anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 }, recommendation: 'y' };
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it('prefers a detector finding over an LLM finding with the same fingerprint, keeping the LLM recommendation', () => {
    const llm = { ...base, id: '1', checkId: 'g-con-numbers', anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 }, recommendation: 'Reconcile the two numbers you give.' };
    const det = { ...base, id: '2', agent: 'detector' as const, checkId: 'g-con-numbers', anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 }, recommendation: 'Check.' };
    const out = dedupeFindings([llm, det]);
    expect(out).toHaveLength(1);
    expect(out[0].agent).toBe('detector');
    expect(out[0].recommendation).toBe('Reconcile the two numbers you give.');
  });
});

describe('dropDismissed', () => {
  it('drops a finding whose fingerprint the author dismissed', () => {
    const f = { runId: 'r', id: '1', checkId: 'g-rig-power', agent: 'statistician' as const, anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 }, issue: 'i', recommendation: 'r', severity: 'major' as const, verification: 'unverified' as const, status: 'open' as const };
    expect(dropDismissed([f], [fingerprint(f.checkId, f.anchor)])).toEqual([]);
    expect(dropDismissed([f], ['g-rig-power|elsewhere#0|sixty animals'])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/services/review/findings.test.ts`
Expected: FAIL — `Failed to resolve import "./findings"`.

- [ ] **Step 3: Write `findings.ts`**

```ts
/**
 * Model responses become findings here, and nowhere else. Every field is validated against what was actually
 * offered: a checkId outside the asked set, a sectionKey that was not offered, or an empty issue is dropped and
 * counted, so the eval can report how often a provider ignored the schema (spec §9).
 */
import { fingerprint, type FindingAnchor } from './anchor';
import { checkById } from './checklist';
import type { CrossFinding } from './crossChecks';
import type { ReviewerRole, Severity } from './types';

export interface Finding {
  id: string;
  runId: string;
  checkId: string;
  agent: ReviewerRole | 'detector';
  anchor: FindingAnchor;
  issue: string;
  recommendation: string;
  severity: Severity;
  /** 'unverified' when the verify step failed or was skipped. */
  verification: 'verified' | 'unverified';
  /** 'noted' = the author inserted it into the document as a note. */
  status: 'open' | 'dismissed' | 'noted';
}

export interface MapCounts {
  droppedCheckId: number;
  droppedSectionKey: number;
  droppedEmpty: number;
}

export interface MapOptions {
  runId: string;
  /** Set for a per-check call; absent for a role-batched call, where the model names the check. */
  checkId?: string;
  agent: ReviewerRole | 'detector';
  sectionKeys: readonly string[];
  checkIds: readonly string[];
  sectionText: (key: string) => string;
}

let seq = 0;
const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** How many times `quote` already occurred in this section's text before this finding's own match. */
function occurrenceOf(text: string, quote: string, used: Map<string, number>): number {
  const key = quote.toLowerCase().replace(/\s+/g, ' ');
  const n = used.get(key) ?? 0;
  used.set(key, n + 1);
  return n;
}

export function mapProblems(raw: unknown, opts: MapOptions): { findings: Finding[]; counts: MapCounts } {
  const counts: MapCounts = { droppedCheckId: 0, droppedSectionKey: 0, droppedEmpty: 0 };
  const findings: Finding[] = [];
  if (raw === null || typeof raw !== 'object') return { findings, counts };
  const list = (raw as { problems?: unknown; findings?: unknown }).problems ?? (raw as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return { findings, counts };

  const used = new Map<string, number>();
  for (const item of list) {
    if (item === null || typeof item !== 'object') { counts.droppedEmpty++; continue; }
    const p = item as Record<string, unknown>;

    const checkId = opts.checkId ?? str(p.checkId);
    if (!checkId || !opts.checkIds.includes(checkId)) { counts.droppedCheckId++; continue; }
    const check = checkById(checkId);
    if (!check) { counts.droppedCheckId++; continue; }

    const sectionKey = str(p.sectionKey);
    if (!opts.sectionKeys.includes(sectionKey)) { counts.droppedSectionKey++; continue; }

    const issue = str(p.issue);
    if (!issue) { counts.droppedEmpty++; continue; }

    const quoteText = str(p.quote);
    const quote = quoteText === '' ? null : quoteText;
    const occurrence = quote === null ? 0 : occurrenceOf(opts.sectionText(sectionKey), quote, used);

    findings.push({
      id: newId(),
      runId: opts.runId,
      checkId,
      agent: opts.agent,
      anchor: { sectionKey, quote, occurrence },
      issue,
      recommendation: str(p.recommendation),
      severity: check.severity,
      verification: 'unverified',
      status: 'open',
    });
  }
  return { findings, counts };
}

export function fromCrossFindings(cross: CrossFinding[], runId: string): Finding[] {
  return cross.map(c => ({
    id: newId(),
    runId,
    checkId: c.checkId,
    agent: 'detector' as const,
    anchor: { sectionKey: c.sectionKey, quote: c.quote || null, occurrence: 0 },
    issue: c.issue,
    recommendation: c.recommendation,
    severity: c.severity,
    verification: 'verified' as const,
    status: 'open' as const,
  }));
}

/**
 * Equal fingerprints merge. The longer recommendation wins, because the model that wrote more usually said what
 * to do; a detector's agent label wins, because a deterministic finding is the one worth trusting (spec §3.6).
 * Containment across DIFFERENT checks suppresses nothing: two checks may fairly criticise the same sentence.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byPrint = new Map<string, Finding>();
  for (const f of findings) {
    const key = fingerprint(f.checkId, f.anchor);
    const prev = byPrint.get(key);
    if (!prev) { byPrint.set(key, f); continue; }
    byPrint.set(key, {
      ...prev,
      agent: prev.agent === 'detector' || f.agent === 'detector' ? 'detector' : prev.agent,
      verification: prev.verification === 'verified' || f.verification === 'verified' ? 'verified' : prev.verification,
      recommendation: f.recommendation.length > prev.recommendation.length ? f.recommendation : prev.recommendation,
      issue: f.issue.length > prev.issue.length ? f.issue : prev.issue,
    });
  }
  return [...byPrint.values()];
}

export function dropDismissed(findings: Finding[], dismissed: readonly string[]): Finding[] {
  if (dismissed.length === 0) return findings;
  const set = new Set(dismissed);
  return findings.filter(f => !set.has(fingerprint(f.checkId, f.anchor)));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/services/review/findings.test.ts`
Expected: PASS, 12 tests. If the severity assertion fails, read `g-rig-power`'s own `severity` in `checklist.ts` and assert that value — the point of the test is that the model's `severity` is ignored, not which value wins.

- [ ] **Step 5: Commit**

```bash
git add src/services/review/findings.ts src/services/review/findings.test.ts
git commit -m "feat(review): validate and dedupe model findings"
```

---
### Task 3: `renderCheckPrompt` — one call, one question

The exact prompt text below is the one measured in the probe on 2026-10-14 (see **Measured before planning**). Do not reword it: `evidence` before `verdict` is what suppresses false alarms, and the `not_applicable` option is what stops a weak model inventing a problem for a check that does not apply.

**Files:**
- Modify: `src/services/review/prompt.ts` (add to it; `renderRolePrompt` stays exactly as it is)
- Test: `src/services/review/prompt.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `ReviewCheck`, `PromptContext` (already in the file).
- Produces:
  ```ts
  export interface CheckPrompt { checkId: string; system: string; user: (body: string) => string; sectionKeys: string[]; schema: Record<string, unknown> }
  export function renderCheckPrompt(check: ReviewCheck, ctx: PromptContext, opts?: { scoped?: boolean }): CheckPrompt | null;
  ```
  `user` is a function of the document body so the engine can pass either the whole document or that check's excerpts without re-rendering the question. `opts.scoped` adds the sentence that tells the model it is seeing excerpts, not the document. Returns `null` when no section key can be offered (same rule as `renderRolePrompt`).

- [ ] **Step 1: Write the failing tests**

Append to `src/services/review/prompt.test.ts`:

```ts
describe('renderCheckPrompt', () => {
  const ctx = {
    docType: 'grant' as const,
    sections: [
      { key: 'specific-aims#0', kind: 'aims' as const, title: 'Specific Aims', text: 'Aim 1 tests the hypothesis.' },
      { key: 'approach#0', kind: 'approach' as const, title: 'Approach', text: 'We will enrol sixty animals.' },
      { key: 'references#0', kind: 'references' as const, title: 'References', text: '1. Smith et al.' },
      { key: 'innovation#0', kind: 'innovation' as const, title: 'Innovation', text: '' },
    ],
    mechanism: 'R01',
    projectYears: 5,
  };
  const check = checksFor('grant', 'statistician').find(c => c.id === 'g-rig-power')!;

  it('puts the procedure and both examples in the user prompt', () => {
    const p = renderCheckPrompt(check, ctx)!;
    const body = p.user('DOCUMENT BODY');
    expect(body).toContain('DOCUMENT BODY');
    expect(body).toContain('How to check:');
    for (const s of check.steps) expect(body).toContain(s);
    expect(body).toContain(check.failExample);
    expect(body).toContain(check.passExample);
    expect(body).toContain('Adequate when:');
  });

  it('asks for evidence, then a verdict, then problems — in that order', () => {
    const body = renderCheckPrompt(check, ctx)!.user('x');
    const iEvidence = body.indexOf('1) evidence');
    const iVerdict = body.indexOf('2) verdict');
    const iProblems = body.indexOf('3) problems');
    expect(iEvidence).toBeGreaterThan(-1);
    expect(iVerdict).toBeGreaterThan(iEvidence);
    expect(iProblems).toBeGreaterThan(iVerdict);
    expect(body).toContain('not_applicable');
  });

  it('offers only sections with a body, and never references', () => {
    const p = renderCheckPrompt(check, ctx)!;
    expect(p.sectionKeys).toEqual(['specific-aims#0', 'approach#0']);
    const problems = (p.schema as any).properties.problems.items;
    expect(problems.properties.sectionKey.enum).toEqual(['specific-aims#0', 'approach#0']);
    expect(problems.additionalProperties).toBe(false);
  });

  it('constrains the verdict to three values and does not ask the model for severity', () => {
    const schema = renderCheckPrompt(check, ctx)!.schema as any;
    expect(schema.properties.verdict.enum).toEqual(['pass', 'fail', 'not_applicable']);
    expect(schema.required).toEqual(['evidence', 'verdict', 'problems']);
    expect(JSON.stringify(schema)).not.toContain('severity');
  });

  it('states the mechanism and the project period in the system prompt, and says so when the period is unknown', () => {
    expect(renderCheckPrompt(check, ctx)!.system).toContain('R01');
    expect(renderCheckPrompt(check, ctx)!.system).toContain('5 years');
    expect(renderCheckPrompt(check, { ...ctx, projectYears: undefined })!.system).toContain('not stated');
  });

  it('tells the model it is seeing excerpts only when it is', () => {
    expect(renderCheckPrompt(check, ctx, { scoped: true })!.system).toContain('excerpts');
    expect(renderCheckPrompt(check, ctx)!.system).not.toContain('excerpts');
  });

  it('offers the single key of a headingless document', () => {
    const p = renderCheckPrompt(check, { ...ctx, sections: [{ key: 'document', kind: 'any', title: '', text: 'Some prose.' }] })!;
    expect(p.sectionKeys).toEqual(['document']);
  });

  it('returns null when no section has a body', () => {
    expect(renderCheckPrompt(check, { ...ctx, sections: [{ key: 'approach#0', kind: 'approach', title: 'Approach', text: '  ' }] })).toBeNull();
  });
});
```

Add `renderCheckPrompt` and `checksFor` to the file's imports if they are not already there.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/services/review/prompt.test.ts`
Expected: FAIL — `renderCheckPrompt is not a function`.

- [ ] **Step 3: Add `renderCheckPrompt` to `prompt.ts`**

```ts
/** The per-check output order. `evidence` first is load-bearing: it is what suppressed false alarms in the spike. */
const WORK_ORDER = [
  'Work in this order.',
  '1) evidence: copy up to 3 short passages from the document that address the question, exactly as written ([] if none).',
  '2) verdict: "pass" if the evidence meets the "Adequate when" criterion; "fail" if it does not, or nothing addresses it; "not_applicable" if the question does not apply to this document.',
  '3) problems: only if fail, each distinct problem (at most 3): sectionKey from the === markers (where the problem is, or where missing material belongs), quote (the exact problematic text, or "" when something is missing), issue (1-2 sentences a reviewer would write), recommendation (1 sentence: what to add or change). Otherwise [].',
];

const SYSTEM_TAIL = 'Answer only from the document. Copy quotes exactly from it. Never invent data, numbers, results or citations. Return JSON only.';

const SCOPED_NOTE =
  ' You see an outline of the whole document and the excerpts a search found most relevant to the question; the excerpts are complete paragraphs copied from the document. ' +
  'If no excerpt addresses the question, treat the material as missing from the document.';

export interface CheckPrompt {
  checkId: string;
  system: string;
  /** Takes the document body (whole document, or this check's excerpts) and returns the full user prompt. */
  user: (body: string) => string;
  sectionKeys: string[];
  schema: Record<string, unknown>;
}

function checkSystem(ctx: PromptContext, scoped: boolean): string {
  const who = ctx.docType === 'grant'
    ? [
        'You review research grant applications as a careful NIH-style study section reviewer.',
        ctx.mechanism?.trim() ? `Mechanism: ${ctx.mechanism.trim()}.` : '',
        ctx.projectYears ? `Project period: ${ctx.projectYears} years.` : 'Project period: not stated; judge scope against the mechanism.',
      ].filter(Boolean).join(' ')
    : 'You review scientific research manuscripts as a careful journal peer reviewer.';
  const parts = [`${ctx.customPreamble?.trim() || who} You answer one review question at a time.${scoped ? SCOPED_NOTE : ''}`];
  const funder = ctx.funderInstructions?.trim().replace(/"{3,}/g, '"');
  if (funder) parts.push(`Funder instructions from the author:\n"""\n${funder.slice(0, FUNDER_INSTRUCTIONS_CAP)}\n"""`);
  parts.push(SYSTEM_TAIL);
  return parts.join('\n\n');
}

export function checkSchema(sectionKeys: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['evidence', 'verdict', 'problems'],
    properties: {
      evidence: { type: 'array', maxItems: 3, items: { type: 'string' } },
      verdict: { type: 'string', enum: ['pass', 'fail', 'not_applicable'] },
      problems: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sectionKey', 'quote', 'issue', 'recommendation'],
          properties: {
            sectionKey: { type: 'string', enum: sectionKeys },
            quote: { type: 'string' },
            issue: { type: 'string' },
            recommendation: { type: 'string' },
          },
        },
      },
    },
  };
}

export function renderCheckPrompt(check: ReviewCheck, ctx: PromptContext, opts: { scoped?: boolean } = {}): CheckPrompt | null {
  const sectionKeys = ctx.sections
    .filter(s => s.kind !== 'references' && !(s.text !== undefined && s.text.trim() === ''))
    .map(s => s.key);
  if (sectionKeys.length === 0) return null;

  const question = [
    '=== REVIEW QUESTION ===',
    `[${check.id}] ${check.name}`,
    `Question: ${check.question}`,
    `Adequate when: ${check.passes.replace(/^Adequate when /, '')}`,
    'How to check:',
    ...check.steps.map((s, i) => `${i + 1}. ${s}`),
    `Fails, for example: "${check.failExample}"`,
    `Passes, for example: "${check.passExample}"`,
    ...WORK_ORDER,
  ].join('\n');

  return {
    checkId: check.id,
    system: checkSystem(ctx, opts.scoped === true),
    user: (body: string) => `${body}\n\n${question}`,
    sectionKeys,
    schema: checkSchema(sectionKeys),
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/services/review/prompt.test.ts`
Expected: PASS, including the R1 tests, which must not change.

- [ ] **Step 5: Commit**

```bash
git add src/services/review/prompt.ts src/services/review/prompt.test.ts
git commit -m "feat(review): per-check prompt rendering"
```

---
### Task 4: `excerpts.ts` — the deterministic search that scopes one check

Above roughly 8k tokens a document does not fit in a local model's context window alongside 48 questions, and the probe showed that it does not need to: an outline, the verbatim Specific Aims and the paragraphs a keyword search picks for one check reach the same recall at a bounded prompt size. This module is pure and has no model in it.

**Files:**
- Create: `src/services/review/excerpts.ts`
- Test: `src/services/review/excerpts.test.ts`

**Interfaces:**
- Consumes: `Section`, `ReviewCheck` from `./types`; `sectionMarker` from `./prompt`.
- Produces:
  ```ts
  export const EXCERPT_WORDS = 1500;
  export const AIMS_WORDS = 500;
  export const PARAGRAPH_WORD_CAP = 450;
  export function outline(sections: Section[]): string;
  export function retrieve(sections: Section[], check: ReviewCheck, limitWords?: number): string;
  export function wholeDocumentFits(sections: Section[], budgetTokens?: number): boolean;
  export function excerptBudgetWords(contextTokens: number, outlineChars: number): number;
  ```

**The budget is derived, not fixed.** In the probe, a flat 1,500-word excerpt budget plus the R01's 50-line outline
and its verbatim aims produced a 6,659-token prompt. Against a model serving 6,144 tokens per slot, **every one of
the 28 calls failed with a context-size error and the document scored 0/9 from the LLM** — a silent total failure
that looked like a model that found nothing. `excerptBudgetWords` exists so that cannot happen: the engine passes
the context window it has, and the budget is whatever is left after the outline, the question and the reply.

- [ ] **Step 1: Write the failing tests**

`src/services/review/excerpts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checksFor } from './checklist';
import { EXCERPT_WORDS, excerptBudgetWords, outline, retrieve, wholeDocumentFits } from './excerpts';
import type { Section } from './types';

function section(over: Partial<Section> & { key: string; text: string }): Section {
  return { kind: 'approach', title: over.key, level: 1, from: 0, to: 1, headingFrom: 0, headingTo: 1, ...over } as Section;
}

const power = checksFor('grant', 'statistician').find(c => c.id === 'g-rig-power')!;

describe('outline', () => {
  it('lists every section with its kind and word count, and quotes the aims verbatim', () => {
    const out = outline([
      section({ key: 'specific-aims#0', kind: 'aims', title: 'Specific Aims', text: 'Aim 1 tests the hypothesis.' }),
      section({ key: 'approach#0', title: 'Approach', text: 'One two three four five.' }),
    ]);
    expect(out).toContain('[aims] specific-aims#0 — Specific Aims (5 words)');
    expect(out).toContain('[approach] approach#0 — Approach (5 words)');
    expect(out).toContain('SPECIFIC AIMS (verbatim)');
    expect(out).toContain('Aim 1 tests the hypothesis.');
  });

  it('leaves references out', () => {
    const out = outline([section({ key: 'references#0', kind: 'references', title: 'References', text: '1. Smith.' })]);
    expect(out).not.toContain('references#0');
  });
});

describe('retrieve', () => {
  it('returns the paragraphs that mention the check topic, under their section marker', () => {
    const sections = [
      section({ key: 'approach#0', title: 'Approach', text: 'We will enrol animals.\n\nThe study is powered at 80% to detect a 30% difference, alpha 0.05.' }),
      section({ key: 'significance#0', kind: 'significance', title: 'Significance', text: 'Measles remains a problem.' }),
    ];
    const got = retrieve(sections, power);
    expect(got).toContain('powered at 80%');
    expect(got).toContain('=== [approach] approach#0 — Approach ===');
    expect(got).not.toContain('Measles remains a problem');
  });

  it('emits the chosen paragraphs in document order, not score order', () => {
    const sections = [section({ key: 'approach#0', title: 'Approach', text: 'First paragraph mentions sample size.\n\nSecond paragraph mentions power and sample size and statistics.' })];
    const got = retrieve(sections, power);
    expect(got.indexOf('First paragraph')).toBeLessThan(got.indexOf('Second paragraph'));
  });

  it('respects the word budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about power and sample size ${'filler '.repeat(60)}`).join('\n\n');
    const got = retrieve([section({ key: 'approach#0', title: 'Approach', text: long })], power, 300);
    expect(got.split(/\s+/).length).toBeLessThan(900);
  });

  it('returns an empty string when nothing scores, so the caller can say the material is missing', () => {
    expect(retrieve([section({ key: 'approach#0', kind: 'any', title: '', text: 'zzz qqq.' })], power)).toBe('');
  });

  it('never returns a references paragraph', () => {
    const sections = [section({ key: 'references#0', kind: 'references', title: 'References Cited', text: 'Smith J. Power analysis in mouse studies. 2019.' })];
    expect(retrieve(sections, power)).toBe('');
  });

  it('finishes promptly on a 25k-word document (bounded repetition)', () => {
    const big = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about power, statistics, sample size and animals. ${'word '.repeat(60)}`).join('\n\n');
    const t0 = Date.now();
    retrieve([section({ key: 'approach#0', title: 'Approach', text: big })], power);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('excerptBudgetWords', () => {
  it('shrinks the budget when the context window is small', () => {
    const small = excerptBudgetWords(6144, 4000);
    const large = excerptBudgetWords(32768, 4000);
    expect(small).toBeLessThan(large);
    expect(small).toBeGreaterThan(0);
  });

  it('never returns a budget whose prompt could not fit', () => {
    // outline 4000 chars + question ~2000 chars + reply 900 tokens must all fit in 6144 tokens
    const words = excerptBudgetWords(6144, 4000);
    const promptTokens = (4000 + 2000 + words * 6) / 3.6 + 900;
    expect(promptTokens).toBeLessThanOrEqual(6144);
  });

  it('returns at least a floor so a tiny window still asks the question', () => {
    expect(excerptBudgetWords(2048, 8000)).toBeGreaterThanOrEqual(120);
  });
});

describe('wholeDocumentFits', () => {
  it('says yes for a short document and no for a long one', () => {
    expect(wholeDocumentFits([section({ key: 'a#0', text: 'short text here' })])).toBe(true);
    expect(wholeDocumentFits([section({ key: 'a#0', text: 'word '.repeat(20000) })])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/services/review/excerpts.test.ts`
Expected: FAIL — `Failed to resolve import "./excerpts"`.

- [ ] **Step 3: Write `excerpts.ts`**

The scoring weights are the ones measured in the spike and the probe: a cue word quoted inside a procedure step is worth 2, a topic word from the check's name or question 0.5, and a paragraph already sitting under a heading of the right kind 1.

```ts
/**
 * What one check gets to read. Above ~8k tokens the whole document does not fit in a local model's window next to
 * 48 questions, and it does not need to: the outline plus the paragraphs a keyword search picks reach the same
 * recall at a bounded prompt size (measured 2026-10-14). Pure: no model, no network.
 */
import { sectionMarker } from './prompt';
import type { ReviewCheck, Section } from './types';

export const EXCERPT_WORDS = 1500;
export const AIMS_WORDS = 500;
export const PARAGRAPH_WORD_CAP = 450;
/** Whole-document delivery is used below this; above it, excerpts. Tokens are estimated at 1 per 3.6 characters. */
export const WHOLE_DOCUMENT_TOKENS = 8000;

const STOP = new Set([
  'each', 'with', 'that', 'this', 'from', 'have', 'been', 'when', 'what', 'which', 'their',
  'there', 'they', 'into', 'than', 'then', 'does', 'other', 'every', 'such', 'about', 'stated', 'state',
]);

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Cues come from the check's own procedure: a phrase the steps quote is a phrase worth finding in the document. */
function cuesFor(check: ReviewCheck): { quoted: string[]; topic: string[] } {
  const steps = check.steps.join(' ');
  const quoted = [...steps.matchAll(/'([^']{2,40})'/g)]
    .map(m => m[1].toLowerCase().replace(/\.\.\./g, '').trim())
    .filter(Boolean);
  const topic = `${check.name} ${check.question}`.toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !STOP.has(w)) ?? [];
  return { quoted: [...new Set(quoted)], topic: [...new Set(topic)] };
}

export function outline(sections: Section[]): string {
  const body = sections.filter(s => s.kind !== 'references');
  const lines = body.map(s => `- [${s.kind}] ${s.key} — ${s.title || '(untitled)'} (${words(s.text)} words)`);
  const aims = body.filter(s => s.kind === 'aims').map(s => s.text).join('\n').split(/\s+/).slice(0, AIMS_WORDS).join(' ');
  return ['OUTLINE OF THE WHOLE DOCUMENT', ...lines, aims ? `\nSPECIFIC AIMS (verbatim)\n${aims}` : ''].join('\n');
}

export function retrieve(sections: Section[], check: ReviewCheck, limitWords: number = EXCERPT_WORDS): string {
  const { quoted, topic } = cuesFor(check);
  const paras: { key: string; kind: string; title: string; text: string; order: number; score: number }[] = [];
  let order = 0;
  for (const s of sections) {
    if (s.kind === 'references') continue;
    for (const raw of s.text.split('\n\n')) {
      const text = raw.trim();
      if (!text) continue;
      const low = text.toLowerCase();
      let score = 0;
      for (const q of quoted) if (low.includes(q)) score += 2;
      for (const w of topic) if (low.includes(w)) score += 0.5;
      if ((check.sections as readonly string[]).includes(s.kind)) score += 1;
      paras.push({ key: s.key, kind: s.kind, title: s.title, text, order: order++, score });
    }
  }

  const chosen: typeof paras = [];
  let budget = limitWords;
  for (const p of [...paras].sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (p.score <= 0) break;
    const n = words(p.text);
    const cost = Math.min(n, PARAGRAPH_WORD_CAP);
    if (cost > budget) continue;
    const text = n > PARAGRAPH_WORD_CAP ? `${p.text.split(/\s+/).slice(0, PARAGRAPH_WORD_CAP).join(' ')} …` : p.text;
    chosen.push({ ...p, text });
    budget -= cost;
    if (budget < 60) break;
  }

  chosen.sort((a, b) => a.order - b.order);
  const out: string[] = [];
  let last = '';
  for (const p of chosen) {
    if (p.key !== last) {
      out.push(sectionMarker({ key: p.key, kind: p.kind as Section['kind'], title: p.title }));
      last = p.key;
    }
    out.push(p.text);
  }
  return out.join('\n');
}

/**
 * How many words of excerpt fit, given the context window the provider actually serves. A flat budget is what made
 * every R01 call fail with a context-size error in the probe (2026-10-14): the outline of a 50-section grant plus
 * its verbatim aims already cost 4k characters, and the reply needs its own room.
 */
export function excerptBudgetWords(contextTokens: number, outlineChars: number): number {
  const RESERVED_REPLY_TOKENS = 900;
  const QUESTION_CHARS = 2500;      // the longest rendered check question, with its procedure and both examples
  const CHARS_PER_TOKEN = 3.6;
  const CHARS_PER_WORD = 6;
  const left = (contextTokens - RESERVED_REPLY_TOKENS) * CHARS_PER_TOKEN - outlineChars - QUESTION_CHARS;
  const words = Math.floor(left / CHARS_PER_WORD);
  return Math.max(120, Math.min(EXCERPT_WORDS, words));
}

export function wholeDocumentFits(sections: Section[], budgetTokens: number = WHOLE_DOCUMENT_TOKENS): boolean {
  const chars = sections.filter(s => s.kind !== 'references').reduce((n, s) => n + s.text.length + s.title.length, 0);
  return chars / 3.6 <= budgetTokens;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/services/review/excerpts.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/review/excerpts.ts src/services/review/excerpts.test.ts
git commit -m "feat(review): deterministic per-check retrieval"
```

---
### Task 5: `engine.ts` — the local tier, with Stop and progress

The orchestrator. It is the only module in `src/services/review/` that calls the network, and it does so only through `callLLM` so provider routing, retries and JSON repair stay in `ai.ts`.

**Files:**
- Create: `src/services/review/engine.ts`
- Test: `src/services/review/engine.test.ts`

**Interfaces:**
- Consumes: `callLLM` from `../ai`; `sectionMap`; `applicableChecks`, `renderCheckPrompt`, `renderSectionedText`; `outline`, `retrieve`, `wholeDocumentFits`; `crossChecks`; `mapProblems`, `fromCrossFindings`, `dedupeFindings`, `dropDismissed`.
- Produces:
  ```ts
  export interface ReviewRun {
    id: string; documentId: string; docType: DocType;
    tier: 'cloud' | 'local'; model: string;
    startedAt: number; finishedAt?: number;
    calls: number; droppedCheckId: number; droppedSectionKey: number; droppedEmpty: number;
    failedChecks: string[];
    status: 'running' | 'complete' | 'stopped';
    summary?: string;
  }
  export interface ReviewProgress { label: string; done: number; total: number }
  export interface RunReviewArgs {
    doc: PMNode; docType: DocType; documentId: string; settings: AISettings;
    mechanism?: string; projectYears?: number; funderInstructions?: string;
    dismissed?: readonly string[];
    signal: AbortSignal;
    onProgress?: (p: ReviewProgress) => void;
  }
  export async function runReview(args: RunReviewArgs): Promise<{ run: ReviewRun; findings: Finding[] }>;
  ```

- [ ] **Step 1: Write the failing test for the call shape and the detector-first rule**

`src/services/review/engine.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import type { AISettings } from '../../types';

const callLLM = vi.fn();
vi.mock('../ai', () => ({ callLLM: (...a: unknown[]) => callLLM(...a) }));

const { runReview } = await import('./engine');

const LOCAL: AISettings = { provider: 'local', localBaseUrl: 'http://127.0.0.1:1/v1/chat/completions', localModel: 'test' } as AISettings;

function grantDoc() {
  const blocks: any[] = [];
  const add = (heading: string, paras: string[]) => {
    blocks.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: heading }] });
    for (const p of paras) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: p }] });
  };
  add('Specific Aims', ['Aim 1 tests whether the vaccine protects. Aim 2 tests durability.']);
  add('Approach', ['We will enrol sixty animals per group and measure titres at week 4.']);
  return getSpecSchema().nodeFromJSON({ type: 'doc', content: blocks });
}

const pass = JSON.stringify({ evidence: ['x'], verdict: 'pass', problems: [] });

beforeEach(() => { callLLM.mockReset(); });

describe('runReview, local tier', () => {
  it('asks one call per applicable check and returns a complete run', async () => {
    callLLM.mockResolvedValue(pass);
    const { run, findings } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: new AbortController().signal,
    });
    expect(callLLM).toHaveBeenCalled();
    expect(run.status).toBe('complete');
    expect(run.tier).toBe('local');
    expect(run.calls).toBe(callLLM.mock.calls.length);
    // every call carried a json schema with the verdict enum
    for (const call of callLLM.mock.calls) {
      const opts = call[7] as { jsonSchema?: any };
      expect(opts?.jsonSchema?.properties?.verdict?.enum).toEqual(['pass', 'fail', 'not_applicable']);
    }
    expect(findings.filter(f => f.agent !== 'detector')).toEqual([]);
  });

  it('maps a failing verdict into an anchored finding', async () => {
    callLLM.mockImplementation(async (user: string) =>
      user.includes('[g-rig-power]')
        ? JSON.stringify({ evidence: [], verdict: 'fail', problems: [{ sectionKey: 'approach#0', quote: 'sixty animals per group', issue: 'No power analysis.', recommendation: 'Add one.' }] })
        : pass);
    const { findings } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: new AbortController().signal,
    });
    const power = findings.find(f => f.checkId === 'g-rig-power');
    expect(power).toBeDefined();
    expect(power!.anchor.quote).toBe('sixty animals per group');
    expect(power!.agent).toBe('statistician');
  });

  it('ignores problems from a passing or not_applicable verdict', async () => {
    callLLM.mockResolvedValue(JSON.stringify({
      evidence: [], verdict: 'not_applicable',
      problems: [{ sectionKey: 'approach#0', quote: 'sixty animals per group', issue: 'Invented.', recommendation: 'x' }],
    }));
    const { findings } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: new AbortController().signal,
    });
    expect(findings.filter(f => f.agent !== 'detector')).toEqual([]);
  });

  it('keeps detector findings when Stop fires before the first response', async () => {
    const ctrl = new AbortController();
    callLLM.mockImplementation(async () => {
      ctrl.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const { run, findings } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: ctrl.signal,
    });
    expect(run.status).toBe('stopped');
    expect(findings.every(f => f.agent === 'detector')).toBe(true);
  });

  it('reports progress as checks complete, and never past the total', async () => {
    callLLM.mockResolvedValue(pass);
    const seen: { done: number; total: number }[] = [];
    await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: new AbortController().signal,
      onProgress: p => seen.push({ done: p.done, total: p.total }),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].done).toBe(seen[seen.length - 1].total);
    for (const p of seen) expect(p.done).toBeLessThanOrEqual(p.total);
  });

  it('records a check whose call failed, and still finishes', async () => {
    let first = true;
    callLLM.mockImplementation(async () => {
      if (first) { first = false; throw new Error('503 from server'); }
      return pass;
    });
    const { run } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: new AbortController().signal,
    });
    expect(run.status).toBe('complete');
    expect(run.failedChecks).toHaveLength(1);
  });

  it('drops a finding whose fingerprint the author already dismissed', async () => {
    callLLM.mockImplementation(async (user: string) =>
      user.includes('[g-rig-power]')
        ? JSON.stringify({ evidence: [], verdict: 'fail', problems: [{ sectionKey: 'approach#0', quote: 'sixty animals per group', issue: 'No power analysis.', recommendation: 'Add one.' }] })
        : pass);
    const { findings } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: LOCAL,
      projectYears: 5, signal: new AbortController().signal,
      dismissed: ['g-rig-power|approach#0|sixty animals per group'],
    });
    expect(findings.find(f => f.checkId === 'g-rig-power')).toBeUndefined();
  });

  it('sends excerpts, not the whole document, once the document is long', async () => {
    callLLM.mockResolvedValue(pass);
    const long = 'We will enrol sixty animals per group and measure titres. '.repeat(900);
    const doc = getSpecSchema().nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Specific Aims' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Aim 1 tests whether the vaccine protects.' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Approach' }] },
        { type: 'paragraph', content: [{ type: 'text', text: long }] },
      ],
    });
    await runReview({ doc, docType: 'grant', documentId: 'd1', settings: LOCAL, projectYears: 5, signal: new AbortController().signal });
    const bodies = callLLM.mock.calls.map(c => String(c[0]));
    expect(bodies.some(b => b.includes('OUTLINE OF THE WHOLE DOCUMENT'))).toBe(true);
    for (const b of bodies) expect(b.length).toBeLessThan(long.length);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/services/review/engine.test.ts`
Expected: FAIL — `Failed to resolve import "./engine"`.

- [ ] **Step 3: Write `engine.ts`**

```ts
/**
 * The review pass. One LLM call per check on the local tier, one per role on the cloud tier (spec §3.3/§3.4),
 * deterministic cross-document detectors first, then one batched verification call. Everything this file does to a
 * response is a pure function from a neighbouring module; what is here is the order, the concurrency, the abort and
 * the counting.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import { callLLM } from '../ai';
import type { AISettings } from '../../types';
import { crossChecks } from './crossChecks';
import { EXCERPT_WORDS, excerptBudgetWords, outline, retrieve, wholeDocumentFits } from './excerpts';
import { dedupeFindings, dropDismissed, fromCrossFindings, mapProblems, type Finding, type MapCounts } from './findings';
import { applicableChecks, renderCheckPrompt, renderRolePrompt, renderSectionedText, type PromptContext } from './prompt';
import { sectionMap } from './sections';
import { REVIEWER_ROLES, type DocType, type ReviewCheck, type Section } from './types';

export interface ReviewRun {
  id: string;
  documentId: string;
  docType: DocType;
  tier: 'cloud' | 'local';
  model: string;
  startedAt: number;
  finishedAt?: number;
  calls: number;
  droppedCheckId: number;
  droppedSectionKey: number;
  droppedEmpty: number;
  /** Check ids (local tier) or role ids (cloud tier) whose call failed. */
  failedChecks: string[];
  status: 'running' | 'complete' | 'stopped';
  summary?: string;
}

export interface ReviewProgress { label: string; done: number; total: number }

export interface RunReviewArgs {
  doc: PMNode;
  docType: DocType;
  documentId: string;
  settings: AISettings;
  mechanism?: string;
  projectYears?: number;
  funderInstructions?: string;
  dismissed?: readonly string[];
  signal: AbortSignal;
  onProgress?: (p: ReviewProgress) => void;
}

/** What one local slot is assumed to serve when the author has not said. llama.cpp divides `-c` by `-np`. */
const DEFAULT_LOCAL_CONTEXT = 8192;
const LOCAL_CONCURRENCY = 3;
const CLOUD_CONCURRENCY = 5;
const MAX_TOKENS = 900;

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function modelOf(s: AISettings): string {
  return (s.provider === 'local' ? s.localModel : s.provider === 'openai' ? s.openaiModel : s.provider === 'anthropic' ? s.anthropicModel : s.geminiModel) || s.provider;
}

export async function runReview(args: RunReviewArgs): Promise<{ run: ReviewRun; findings: Finding[] }> {
  const { doc, docType, documentId, settings, signal, onProgress } = args;
  const tier: 'cloud' | 'local' = settings.provider === 'local' ? 'local' : 'cloud';
  const run: ReviewRun = {
    id: `run-${Date.now().toString(36)}`,
    documentId, docType, tier, model: modelOf(settings),
    startedAt: Date.now(), calls: 0,
    droppedCheckId: 0, droppedSectionKey: 0, droppedEmpty: 0,
    failedChecks: [], status: 'running',
  };

  const sections = sectionMap(doc, docType);
  const offered = sections.filter(s => s.kind !== 'references' && s.text.trim() !== '');
  const textByKey = new Map(sections.map(s => [s.key, s.text]));
  const ctx: PromptContext = {
    docType,
    sections: sections.map(s => ({ key: s.key, kind: s.kind, title: s.title, text: s.text })),
    mechanism: args.mechanism,
    projectYears: args.projectYears,
    funderInstructions: args.funderInstructions,
  };

  // 1. Detectors first: deterministic, instant, and they set the floor under the model (spec §3.4 step 4).
  const collected: Finding[] = docType === 'grant'
    ? fromCrossFindings(crossChecks(sections, args.projectYears), run.id)
    : [];

  const addCounts = (c: MapCounts) => {
    run.droppedCheckId += c.droppedCheckId;
    run.droppedSectionKey += c.droppedSectionKey;
    run.droppedEmpty += c.droppedEmpty;
  };

  try {
    if (tier === 'local') await localPass(args, run, sections, offered, ctx, textByKey, collected, addCounts);
    else await cloudPass(args, run, sections, offered, ctx, textByKey, collected, addCounts);
    run.status = 'complete';
  } catch (e) {
    if (!isAbort(e)) throw e;
    run.status = 'stopped';
  }

  run.finishedAt = Date.now();
  const findings = dropDismissed(dedupeFindings(collected), args.dismissed ?? []);
  return { run, findings };
}

async function localPass(
  args: RunReviewArgs, run: ReviewRun, sections: Section[], offered: Section[], ctx: PromptContext,
  textByKey: Map<string, string>, collected: Finding[], addCounts: (c: MapCounts) => void,
): Promise<void> {
  const checks = REVIEWER_ROLES.flatMap(role => applicableChecks(ctx.docType, role, sections));
  const scoped = !wholeDocumentFits(sections);
  const whole = scoped ? '' : `DOCUMENT\n\n${renderSectionedText(sections)}`;
  const sectionOutline = scoped ? outline(sections) : '';
  // The budget must come from the window the provider serves, or a long grant's calls all fail at once (Task 4).
  const budgetWords = excerptBudgetWords(args.settings.localContextTokens ?? DEFAULT_LOCAL_CONTEXT, sectionOutline.length);
  const keys = offered.map(s => s.key);
  const checkIds = checks.map(c => c.id);
  let done = 0;
  const total = checks.length;
  args.onProgress?.({ label: 'Reviewing', done, total });

  await pool(checks, LOCAL_CONCURRENCY, async (check: ReviewCheck) => {
    if (args.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const prompt = renderCheckPrompt(check, ctx, { scoped });
    if (!prompt) { done++; return; }
    const body = scoped
      ? `${sectionOutline}\n\nEXCERPTS RELEVANT TO THIS QUESTION\n${retrieve(sections, check, budgetWords) || '(the search found nothing relevant)'}`
      : whole;
    try {
      run.calls++;
      const raw = await callLLM(prompt.user(body), args.settings, prompt.system, true, undefined, args.signal, MAX_TOKENS, { jsonSchema: prompt.schema });
      const parsed = JSON.parse(raw) as { verdict?: string };
      if (parsed?.verdict === 'fail') {
        const { findings, counts } = mapProblems(parsed, {
          runId: run.id, checkId: check.id, agent: check.owner,
          sectionKeys: keys, checkIds, sectionText: k => textByKey.get(k) ?? '',
        });
        addCounts(counts);
        collected.push(...findings);
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      run.failedChecks.push(check.id);
    } finally {
      done++;
      args.onProgress?.({ label: `Reviewing · ${check.name}`, done, total });
    }
  });
}
```

`cloudPass` is Task 6. For this task, add a stub so the file type-checks and the local tests run:

```ts
async function cloudPass(
  _args: RunReviewArgs, _run: ReviewRun, _sections: Section[], _offered: Section[], _ctx: PromptContext,
  _textByKey: Map<string, string>, _collected: Finding[], _addCounts: (c: MapCounts) => void,
): Promise<void> {
  throw new Error('cloud tier lands in the next task');
}
```

- [ ] **Step 4: Add `localContextTokens` to `AISettings`**

In `src/types.ts`, beside `localChunkSize`:

```ts
  /** Tokens one local slot serves (llama.cpp `-c` divided by `-np`). Sets the per-check excerpt budget; a wrong
   *  value too high makes every call on a long document fail with a context-size error. Default 8192. */
  localContextTokens?: number;
```

No UI for it in R2 — R3 puts it next to the other local-model settings. The engine reads it with a default, so an
existing saved settings object keeps working untouched.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/services/review/engine.test.ts`
Expected: PASS, 8 tests.

Two failure modes to expect, both in the test and not the code: the `callLLM` argument index for `opts` (count the positional parameters in `ai.ts`: prompt, settings, systemPrompt, jsonMode, images, signal, maxTokens, opts — so `call[7]`), and the section key `approach#0`, which must match what `sectionMap` returns.

- [ ] **Step 6: Confirm the suite is still clean, including no unhandled rejections**

Run: `npx vitest run src/services/review/ && echo "EXIT $?"`
Expected: PASS and `EXIT 0`. The exit code matters independently of the pass count: an abort that rejects after the test finished makes this suite print "passed" and exit 1.

- [ ] **Step 7: Commit**

```bash
git add src/services/review/engine.ts src/services/review/engine.test.ts src/types.ts
git commit -m "feat(review): local review engine, one call per check"
```

---
### Task 6: the cloud tier and the shared verification call

The cloud tier keeps one call per role, which is what the spec's §3.3 argues for and what R1's baseline measured at 80% recall on a strong model. Both tiers end with the same batched verification call.

**Files:**
- Modify: `src/services/review/engine.ts`
- Test: `src/services/review/engine.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `renderRolePrompt` (already imported).
- Produces: nothing new in the public surface. `runReview` now works for both tiers, and `ReviewRun.failedChecks` holds role ids on the cloud tier.

- [ ] **Step 1: Write the failing tests**

Append to `src/services/review/engine.test.ts`:

```ts
const CLOUD: AISettings = { provider: 'anthropic', anthropicApiKey: 'x', anthropicModel: 'claude-test' } as AISettings;

describe('runReview, cloud tier', () => {
  it('makes one call per role plus one verification call', async () => {
    callLLM.mockImplementation(async (user: string) =>
      user.includes('VERIFY') ? JSON.stringify({ keep: [], drop: [] }) : JSON.stringify({ findings: [] }));
    const { run } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: CLOUD,
      projectYears: 5, signal: new AbortController().signal,
    });
    expect(run.tier).toBe('cloud');
    const verifyCalls = callLLM.mock.calls.filter(c => String(c[0]).includes('VERIFY'));
    expect(verifyCalls).toHaveLength(1);
    expect(callLLM.mock.calls.length - verifyCalls.length).toBeLessThanOrEqual(5);
  });

  it('drops a finding the verifier rejects and marks the rest verified', async () => {
    const finding = { checkId: 'g-rig-power', sectionKey: 'approach#0', quote: 'sixty animals per group', issue: 'No power analysis.', recommendation: 'Add one.', severity: 'major' };
    const other = { checkId: 'g-rig-sabv', sectionKey: 'approach#0', quote: 'measure titres at week 4', issue: 'Sex not addressed.', recommendation: 'Address it.', severity: 'major' };
    callLLM.mockImplementation(async (user: string) => {
      if (user.includes('VERIFY')) {
        const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
        return JSON.stringify({ keep: ids.slice(1), drop: [{ id: ids[0], reason: 'the text answers it' }] });
      }
      return user.includes('g-rig-power') ? JSON.stringify({ findings: [finding, other] }) : JSON.stringify({ findings: [] });
    });
    const { findings } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: CLOUD,
      projectYears: 5, signal: new AbortController().signal,
    });
    const llm = findings.filter(f => f.agent !== 'detector');
    expect(llm).toHaveLength(1);
    expect(llm[0].verification).toBe('verified');
  });

  it('keeps every finding as unverified when the verification call fails', async () => {
    callLLM.mockImplementation(async (user: string) => {
      if (user.includes('VERIFY')) throw new Error('500');
      return user.includes('g-rig-power')
        ? JSON.stringify({ findings: [{ checkId: 'g-rig-power', sectionKey: 'approach#0', quote: 'sixty animals per group', issue: 'No power analysis.', recommendation: 'Add one.', severity: 'major' }] })
        : JSON.stringify({ findings: [] });
    });
    const { findings, run } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: CLOUD,
      projectYears: 5, signal: new AbortController().signal,
    });
    const power = findings.find(f => f.checkId === 'g-rig-power');
    expect(power?.verification).toBe('unverified');
    expect(run.status).toBe('complete');
  });

  it('records the role whose call failed and keeps the other roles', async () => {
    callLLM.mockImplementation(async (system: string, _s: unknown, sys: string) => {
      if (String(sys).includes('rigor')) throw new Error('503');
      return JSON.stringify({ findings: [] });
    });
    const { run } = await runReview({
      doc: grantDoc(), docType: 'grant', documentId: 'd1', settings: CLOUD,
      projectYears: 5, signal: new AbortController().signal,
    });
    expect(run.status).toBe('complete');
    expect(run.failedChecks.length).toBeGreaterThan(0);
  });

  it('never drops a detector finding in verification', async () => {
    callLLM.mockImplementation(async (user: string) => {
      if (user.includes('VERIFY')) {
        const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map(m => m[1]);
        return JSON.stringify({ keep: [], drop: ids.map(id => ({ id, reason: 'no' })) });
      }
      return JSON.stringify({ findings: [] });
    });
    const doc = getSpecSchema().nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Specific Aims' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Aim 1. Aim 2. Aim 3 tests durability.' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Approach' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Aim 1 and Aim 2 are described here. Milestones run to Y7Q2.' }] },
      ],
    });
    const { findings } = await runReview({
      doc, docType: 'grant', documentId: 'd1', settings: CLOUD,
      projectYears: 5, signal: new AbortController().signal,
    });
    expect(findings.some(f => f.agent === 'detector')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/services/review/engine.test.ts`
Expected: FAIL — `cloud tier lands in the next task`.

- [ ] **Step 3: Replace the `cloudPass` stub and add `verifyFindings`**

```ts
async function cloudPass(
  args: RunReviewArgs, run: ReviewRun, sections: Section[], offered: Section[], ctx: PromptContext,
  textByKey: Map<string, string>, collected: Finding[], addCounts: (c: MapCounts) => void,
): Promise<void> {
  const whole = renderSectionedText(sections);
  const keys = offered.map(s => s.key);
  const prompts = REVIEWER_ROLES.map(role => renderRolePrompt(role, ctx)).filter((p): p is NonNullable<typeof p> => p !== null);
  let done = 0;
  const total = prompts.length + 1;
  args.onProgress?.({ label: 'Reviewing', done, total });

  await pool(prompts, CLOUD_CONCURRENCY, async prompt => {
    if (args.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    try {
      run.calls++;
      const raw = await callLLM(
        `${whole}\n\nReview the document above against your checks. Return JSON only.`,
        args.settings, prompt.system, true, undefined, args.signal, 2500, { jsonSchema: prompt.schema },
      );
      const { findings, counts } = mapProblems(JSON.parse(raw), {
        runId: run.id, agent: prompt.role,
        sectionKeys: keys, checkIds: prompt.checkIds, sectionText: k => textByKey.get(k) ?? '',
      });
      addCounts(counts);
      collected.push(...findings);
    } catch (e) {
      if (isAbort(e)) throw e;
      run.failedChecks.push(prompt.role);
    } finally {
      done++;
      args.onProgress?.({ label: 'Reviewing', done, total });
    }
  });

  await verifyFindings(args, run, whole, collected);
  args.onProgress?.({ label: 'Reviewing', done: total, total });
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keep', 'drop'],
  properties: {
    keep: { type: 'array', items: { type: 'string' } },
    drop: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } },
    },
  },
};

/**
 * One call over every LLM finding: the model drops the ones the document already answers somewhere the reviewer
 * did not look. Detector findings are never offered for dropping — they are deterministic, and the spike showed a
 * verifier deleting true findings when it was allowed to second-guess them. A failure keeps everything, unverified.
 */
async function verifyFindings(args: RunReviewArgs, run: ReviewRun, whole: string, collected: Finding[]): Promise<void> {
  const subject = collected.filter(f => f.agent !== 'detector');
  if (subject.length === 0) return;
  const list = subject.map(f => ({ id: f.id, checkId: f.checkId, sectionKey: f.anchor.sectionKey, quote: f.anchor.quote ?? '', issue: f.issue }));
  const user = [
    `DOCUMENT\n\n${whole}`, '',
    '=== VERIFY THESE REVIEWER CLAIMS ===',
    JSON.stringify(list, null, 1),
    '',
    'For each claim, search the WHOLE document — including any separate rigor, statistics, timeline, preliminary-data or summary section — for text that already satisfies exactly the case the claim is about.',
    'Return the ids to keep, and the ids to drop with a one-phrase reason. A claim you are unsure about belongs in keep.',
  ].join('\n');
  try {
    run.calls++;
    const raw = await callLLM(user, args.settings,
      'You check a reviewer\'s claims against the document. Answer only from the document. Return JSON only.',
      true, undefined, args.signal, 1200, { jsonSchema: VERIFY_SCHEMA });
    const parsed = JSON.parse(raw) as { drop?: { id?: unknown }[] };
    const dropped = new Set((Array.isArray(parsed?.drop) ? parsed.drop : []).map(d => String(d?.id ?? '')));
    for (let i = collected.length - 1; i >= 0; i--) {
      const f = collected[i];
      if (f.agent === 'detector') continue;
      if (dropped.has(f.id)) collected.splice(i, 1);
      else collected[i] = { ...f, verification: 'verified' };
    }
  } catch (e) {
    if (isAbort(e)) throw e;
    run.failedChecks.push('verify');
  }
}
```

Then call `verifyFindings` at the end of `localPass` too, after the pool:

```ts
  await verifyFindings(args, run, `DOCUMENT\n\n${renderSectionedText(sections)}`, collected);
```

**Ruling to record if a reviewer objects:** on the local tier the verification call re-sends the whole document, which the per-check pass deliberately avoids. It is one call, not 48, and the spike measured the batched verifier as the cheap half of the pair. If the document does not fit (`!wholeDocumentFits(sections)`), skip verification on the local tier and leave every finding `unverified` — a long grant's findings are better unverified than unreviewed.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/services/review/engine.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/review/engine.ts src/services/review/engine.test.ts
git commit -m "feat(review): cloud tier and batched verification"
```

---
### Task 7: Dexie v7 and the review repository

Findings must survive a reload, and a dismissal must survive a re-run. The schema goes to version 7; no editor schema changes, so the preservation golden hashes are untouched.

**Files:**
- Modify: `src/db/manuscriptDb.ts`
- Modify: `src/types.ts`
- Create: `src/db/reviewRepository.ts`
- Test: `src/db/reviewRepository.test.ts`

**Interfaces:**
- Consumes: `db` from `./manuscriptDb`; `Finding`, `ReviewRun` from the review service; `fingerprint` from `../services/review/anchor`.
- Produces:
  ```ts
  export async function saveRun(run: ReviewRun, findings: Finding[]): Promise<void>;   // replaces the previous run's OPEN findings
  export async function loadFindings(documentId: string): Promise<Finding[]>;          // open + noted, newest run first
  export async function loadLatestRun(documentId: string): Promise<ReviewRun | undefined>;
  export async function dismissFinding(documentId: string, finding: Finding): Promise<void>;
  export async function loadDismissals(documentId: string): Promise<string[]>;
  export async function markNoted(findingId: string): Promise<void>;
  ```

- [ ] **Step 1: Add version 7 to `manuscriptDb.ts`**

After the `version(6)` line, inside the constructor:

```ts
    // v7: review findings and the runs that produced them. `reviewDismissals` (fingerprints) lives on the
    // documents row, so dismissing a finding survives the run that is replaced on the next review.
    this.version(7).stores({
      reviewRuns: 'id, documentId, startedAt',
      findings: 'id, runId, documentId, status',
    });
```

Add the two tables as fields on the class, next to the existing ones:

```ts
  reviewRuns!: Table<ReviewRunRow, string>;
  findings!: Table<FindingRow, string>;
```

- [ ] **Step 2: Add the row types to `src/types.ts`**

```ts
/** A review finding as stored. `documentId` is denormalised onto the row so a reload reads one index. */
export interface FindingRow {
  id: string;
  runId: string;
  documentId: string;
  status: 'open' | 'dismissed' | 'noted';
  /** The Finding, minus the fields above. Kept as one blob: R3 adds fields and must not need a migration. */
  payload: unknown;
}

export interface ReviewRunRow {
  id: string;
  documentId: string;
  startedAt: number;
  payload: unknown;
}
```

And on the stored document row type, add:

```ts
  /** Fingerprints the author dismissed; later runs drop matching findings before display. */
  reviewDismissals?: string[];
```

- [ ] **Step 3: Write the failing repository tests**

`src/db/reviewRepository.test.ts`. Follow whichever fake-IndexedDB setup the existing Dexie tests in this repo use — find it with `grep -rl "indexeddb\|fake-indexeddb" src --include=*.test.ts* | head` and copy that file's setup verbatim rather than introducing a second pattern.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './manuscriptDb';
import { dismissFinding, loadDismissals, loadFindings, loadLatestRun, markNoted, saveRun } from './reviewRepository';
import type { Finding } from '../services/review/findings';
import type { ReviewRun } from '../services/review/engine';

const run = (id: string): ReviewRun => ({
  id, documentId: 'doc-1', docType: 'grant', tier: 'local', model: 'test',
  startedAt: Date.now(), calls: 3, droppedCheckId: 0, droppedSectionKey: 0, droppedEmpty: 0,
  failedChecks: [], status: 'complete',
});

const finding = (id: string, runId: string, over: Partial<Finding> = {}): Finding => ({
  id, runId, checkId: 'g-rig-power', agent: 'statistician',
  anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 },
  issue: 'No power analysis.', recommendation: 'Add one.', severity: 'major',
  verification: 'verified', status: 'open', ...over,
});

describe('reviewRepository', () => {
  beforeEach(async () => {
    await db.findings.clear();
    await db.reviewRuns.clear();
    await db.documents.clear();
    await db.documents.put({ id: 'doc-1' } as never);
  });

  it('round-trips a run and its findings', async () => {
    await saveRun(run('r1'), [finding('f1', 'r1')]);
    expect((await loadFindings('doc-1')).map(f => f.id)).toEqual(['f1']);
    expect((await loadLatestRun('doc-1'))?.id).toBe('r1');
  });

  it('replaces the previous run OPEN findings and keeps noted ones', async () => {
    await saveRun(run('r1'), [finding('f1', 'r1'), finding('f2', 'r1', { status: 'noted' })]);
    await saveRun(run('r2'), [finding('f3', 'r2')]);
    const ids = (await loadFindings('doc-1')).map(f => f.id).sort();
    expect(ids).toEqual(['f2', 'f3']);
  });

  it('remembers a dismissal by fingerprint, not by id', async () => {
    const f = finding('f1', 'r1');
    await saveRun(run('r1'), [f]);
    await dismissFinding('doc-1', f);
    expect(await loadDismissals('doc-1')).toEqual(['g-rig-power|approach#0|sixty animals']);
    expect(await loadFindings('doc-1')).toEqual([]);
  });

  it('does not add the same dismissal twice', async () => {
    const f = finding('f1', 'r1');
    await saveRun(run('r1'), [f]);
    await dismissFinding('doc-1', f);
    await dismissFinding('doc-1', { ...f, id: 'f9' });
    expect(await loadDismissals('doc-1')).toHaveLength(1);
  });

  it('keeps a noted finding across two more runs', async () => {
    await saveRun(run('r1'), [finding('f1', 'r1')]);
    await markNoted('f1');
    await saveRun(run('r2'), []);
    await saveRun(run('r3'), []);
    const kept = await loadFindings('doc-1');
    expect(kept.map(f => f.status)).toEqual(['noted']);
  });

  it('returns an empty list for a document that was never reviewed', async () => {
    expect(await loadFindings('doc-never')).toEqual([]);
    expect(await loadLatestRun('doc-never')).toBeUndefined();
    expect(await loadDismissals('doc-never')).toEqual([]);
  });
});
```

- [ ] **Step 4: Run them and confirm they fail**

Run: `npx vitest run src/db/reviewRepository.test.ts`
Expected: FAIL — `Failed to resolve import "./reviewRepository"`.

- [ ] **Step 5: Write `reviewRepository.ts`**

```ts
/**
 * Review findings and runs in Dexie. A review REPLACES the previous run's open findings; what the author dismissed
 * or inserted as a note persists, because those are the author's decisions and not the model's output (spec §2).
 */
import { db } from './manuscriptDb';
import type { ReviewRun } from '../services/review/engine';
import type { Finding } from '../services/review/findings';
import { fingerprint } from '../services/review/anchor';

export async function saveRun(run: ReviewRun, findings: Finding[]): Promise<void> {
  await db.transaction('rw', db.reviewRuns, db.findings, async () => {
    const stale = await db.findings.where({ documentId: run.documentId, status: 'open' }).primaryKeys();
    await db.findings.bulkDelete(stale.filter(id => !findings.some(f => f.id === id)));
    await db.reviewRuns.put({ id: run.id, documentId: run.documentId, startedAt: run.startedAt, payload: run });
    await db.findings.bulkPut(findings.map(f => ({ id: f.id, runId: f.runId, documentId: run.documentId, status: f.status, payload: f })));
  });
}

export async function loadFindings(documentId: string): Promise<Finding[]> {
  const rows = await db.findings.where('documentId').equals(documentId).toArray();
  return rows.filter(r => r.status !== 'dismissed').map(r => r.payload as Finding);
}

export async function loadLatestRun(documentId: string): Promise<ReviewRun | undefined> {
  const rows = await db.reviewRuns.where('documentId').equals(documentId).toArray();
  const latest = rows.sort((a, b) => b.startedAt - a.startedAt)[0];
  return latest?.payload as ReviewRun | undefined;
}

export async function dismissFinding(documentId: string, finding: Finding): Promise<void> {
  const print = fingerprint(finding.checkId, finding.anchor);
  await db.transaction('rw', db.documents, db.findings, async () => {
    const doc = await db.documents.get(documentId);
    if (doc) {
      const prints = new Set([...(doc.reviewDismissals ?? []), print]);
      await db.documents.put({ ...doc, reviewDismissals: [...prints] });
    }
    await db.findings.where('documentId').equals(documentId).modify(row => {
      const f = row.payload as Finding;
      if (fingerprint(f.checkId, f.anchor) === print) {
        row.status = 'dismissed';
        row.payload = { ...f, status: 'dismissed' };
      }
    });
  });
}

export async function loadDismissals(documentId: string): Promise<string[]> {
  return (await db.documents.get(documentId))?.reviewDismissals ?? [];
}

export async function markNoted(findingId: string): Promise<void> {
  await db.findings.where('id').equals(findingId).modify(row => {
    row.status = 'noted';
    row.payload = { ...(row.payload as Finding), status: 'noted' };
  });
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npx vitest run src/db/reviewRepository.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Confirm the preservation hashes did not move**

Run: `npx vitest run src/docx/preserve/hash.test.ts`
Expected: PASS. This task adds Dexie tables, not editor schema, so the golden hashes must be byte-identical. If they moved, something touched the editor schema and the change must be reverted.

- [ ] **Step 8: Commit**

```bash
git add src/db/manuscriptDb.ts src/db/reviewRepository.ts src/db/reviewRepository.test.ts src/types.ts
git commit -m "feat(review): persist findings, runs and dismissals"
```

---
### Task 8: wire it up — store, hook, and findings in the Review panel

R2's user-visible result is the one the spec asks for: "the existing Review list shows the new findings, correctly anchored". The panel layout, filters and Draft-a-fix are R3; this task shows a finding, locates it, and dismisses it.

**Files:**
- Create: `src/stores/useReviewStore.ts`
- Create: `src/components/panels/review/FindingCard.tsx`
- Create: `src/components/panels/review/FindingList.tsx`
- Modify: `src/hooks/useAnalysis.ts`
- Modify: `src/components/panels/ReviewPanel.tsx`
- Test: `src/stores/useReviewStore.test.ts`, `src/components/panels/review/FindingList.test.tsx`
- Modify: `src/components/shell/reachability.test.tsx`

**Interfaces:**
- Consumes: `runReview`, `ReviewRun`, `ReviewProgress`; `Finding`; `resolveAnchor`; the repository from Task 7.
- Produces:
  ```ts
  // useReviewStore
  interface ReviewState {
    findings: Finding[]; run?: ReviewRun; progress?: ReviewProgress;
    initialize(documentId: string): Promise<void>;
    setRun(run: ReviewRun, findings: Finding[]): Promise<void>;
    setProgress(p?: ReviewProgress): void;
    dismiss(documentId: string, finding: Finding): Promise<void>;
    clear(): void;
  }
  ```

- [ ] **Step 1: Write the failing store test**

`src/stores/useReviewStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useReviewStore } from './useReviewStore';
import { db } from '../db/manuscriptDb';
import type { Finding } from '../services/review/findings';
import type { ReviewRun } from '../services/review/engine';

const run: ReviewRun = {
  id: 'r1', documentId: 'doc-1', docType: 'grant', tier: 'local', model: 'test',
  startedAt: 1, calls: 1, droppedCheckId: 0, droppedSectionKey: 0, droppedEmpty: 0,
  failedChecks: [], status: 'complete',
};
const f: Finding = {
  id: 'f1', runId: 'r1', checkId: 'g-rig-power', agent: 'statistician',
  anchor: { sectionKey: 'approach#0', quote: 'sixty animals', occurrence: 0 },
  issue: 'No power analysis.', recommendation: 'Add one.', severity: 'major',
  verification: 'verified', status: 'open',
};

describe('useReviewStore', () => {
  beforeEach(async () => {
    await db.findings.clear(); await db.reviewRuns.clear(); await db.documents.clear();
    await db.documents.put({ id: 'doc-1' } as never);
    useReviewStore.getState().clear();
  });

  it('holds a run and reloads it from the database', async () => {
    await useReviewStore.getState().setRun(run, [f]);
    expect(useReviewStore.getState().findings).toHaveLength(1);
    useReviewStore.getState().clear();
    await useReviewStore.getState().initialize('doc-1');
    expect(useReviewStore.getState().findings.map(x => x.id)).toEqual(['f1']);
  });

  it('removes a dismissed finding from the list and remembers it', async () => {
    await useReviewStore.getState().setRun(run, [f]);
    await useReviewStore.getState().dismiss('doc-1', f);
    expect(useReviewStore.getState().findings).toEqual([]);
    await useReviewStore.getState().initialize('doc-1');
    expect(useReviewStore.getState().findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Write `useReviewStore.ts` and make the test pass**

Mirror `useAIStore`'s shape — Zustand `create`, no persistence middleware; Dexie is the persistence.

```ts
/** Findings in memory for the Review panel. Dexie is the record; this is the view of it. */
import { create } from 'zustand';
import type { ReviewProgress, ReviewRun } from '../services/review/engine';
import type { Finding } from '../services/review/findings';
import { dismissFinding, loadFindings, loadLatestRun, saveRun } from '../db/reviewRepository';

interface ReviewState {
  findings: Finding[];
  run?: ReviewRun;
  progress?: ReviewProgress;
  initialize: (documentId: string) => Promise<void>;
  setRun: (run: ReviewRun, findings: Finding[]) => Promise<void>;
  setProgress: (p?: ReviewProgress) => void;
  dismiss: (documentId: string, finding: Finding) => Promise<void>;
  clear: () => void;
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  findings: [],
  initialize: async documentId => {
    const [findings, run] = await Promise.all([loadFindings(documentId), loadLatestRun(documentId)]);
    set({ findings, run });
  },
  setRun: async (run, findings) => {
    await saveRun(run, findings);
    set({ run, findings, progress: undefined });
  },
  setProgress: progress => set({ progress }),
  dismiss: async (documentId, finding) => {
    await dismissFinding(documentId, finding);
    set({ findings: get().findings.filter(f => f.id !== finding.id) });
  },
  clear: () => set({ findings: [], run: undefined, progress: undefined }),
}));
```

Run: `npx vitest run src/stores/useReviewStore.test.ts` → PASS.

- [ ] **Step 3: Write the failing list test**

`src/components/panels/review/FindingList.test.tsx`. Copy the render setup from an existing panel test (`grep -rl "render(" src/components/panels --include=*.test.tsx | head`).

```tsx
it('shows each finding with its check name and a Locate button', () => {
  render(<FindingList findings={[finding]} onLocate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('No power analysis.')).toBeInTheDocument();
  expect(screen.getByTestId('control-finding-locate')).toBeInTheDocument();
});

it('says "text changed" and offers only Dismiss when the anchor is lost', () => {
  render(<FindingList findings={[finding]} anchorState={{ f1: 'lost' }} onLocate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(/text changed/i)).toBeInTheDocument();
  expect(screen.queryByTestId('control-finding-locate')).not.toBeInTheDocument();
});

it('says "moved" when the quote was found outside its section', () => {
  render(<FindingList findings={[finding]} anchorState={{ f1: 'moved' }} onLocate={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(/moved/i)).toBeInTheDocument();
});

it('lists findings in document order, not by severity', () => {
  const minorInAims = { ...finding, id: 'f0', severity: 'minor' as const, issue: 'Aims issue.', anchor: { sectionKey: 'specific-aims#0', quote: 'Aim 1', occurrence: 0 } };
  const criticalInApproach = { ...finding, id: 'f1', severity: 'critical' as const, issue: 'Approach issue.' };
  render(
    <FindingList
      findings={[criticalInApproach, minorInAims]}
      sectionOrder={['specific-aims#0', 'approach#0']}
      onLocate={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  const rendered = screen.getAllByTestId('finding-card').map(el => el.textContent ?? '');
  expect(rendered[0]).toContain('Aims issue.');
  expect(rendered[1]).toContain('Approach issue.');
});
```

- [ ] **Step 4: Write `FindingCard.tsx` and `FindingList.tsx`**

The card shows: the check name (`checkById(f.checkId)!.name`), a severity chip, the issue, the recommendation, the quote (or "missing from <section title>" when `anchor.quote === null`), and the buttons. Give the buttons literal test ids: `control-finding-locate`, `control-finding-dismiss`. Reuse the existing suggestion card's visual language rather than inventing a second one — read `src/components/panels/review/` and the suggestion card first and match its spacing, chip and button components.

`FindingList` takes:

```ts
interface FindingListProps {
  findings: Finding[];
  /** Section keys in document order, from `sectionMap`. Findings sort by this, then by quote position. */
  sectionOrder?: string[];
  /** Per finding id, what `resolveAnchor` said. Computed once per render by the panel, not per card. */
  anchorState?: Record<string, 'ok' | 'moved' | 'lost'>;
  onLocate: (f: Finding) => void;
  onDismiss: (f: Finding) => void;
}
```

Every card carries `data-testid="finding-card"` so the order test can read the list. Severity sets the chip colour and nothing else: the list reads in document order, because that is the order the author will fix things in.

- [ ] **Step 5: Wire `useAnalysis.ts`**

In `handleAnalyze`, the no-`specificAgent` branch runs the review. Replace the crew call with `runReview`, keeping Stop and the toast behaviour:

```ts
        const doc = editorRef.current?.getDoc();
        if (!doc) { showToast('Open a document first.', 'info'); return; }
        const { run, findings } = await runReview({
          doc,
          docType: mode === 'grant' ? 'grant' : 'manuscript',
          documentId: currentDocumentId,
          settings: aiSettings,
          mechanism: activeTemplate?.mechanism,
          projectYears: activeTemplate?.projectYears,
          funderInstructions: aiSettings.grantInstructions,
          dismissed: await loadDismissals(currentDocumentId),
          signal,
          onProgress: p => setAnalysisProgress({ agent: p.label, total: p.total, done: p.done }),
        });
        await useReviewStore.getState().setRun(run, findings);
        if (run.status === 'stopped') showToast(`Stopped · ${findings.length} findings kept`, 'info');
        else if (findings.length === 0) showToast('No issues found against the checklist.', 'info');
        else {
          const failed = run.failedChecks.length ? ` · ${run.failedChecks.length} checks failed` : '';
          showToast(`${findings.length} findings from ${run.calls} calls${failed}`, 'success');
        }
```

The editor handle may not expose `getDoc()`. Check `src/components/editor/useEditorHandle.ts`; if it does not, add it there (`getDoc: () => editor.state.doc`) in this task and nowhere else.

Keep the `specificAgent` branch calling the old `analyzeText` path: R4 deletes it. Copy-edit is not part of Review, so the `editor` agent is NOT in this pass.

- [ ] **Step 6: Render the findings in `ReviewPanel.tsx`**

Above the existing suggestion list, add a `Section` titled "Review" holding `FindingList`, fed from `useReviewStore`. `onLocate` calls `resolveAnchor(doc, docType, f.anchor)` and scrolls the editor to the result; `onDismiss` calls the store's `dismiss`. Compute `anchorState` once per render from the current document, not per card.

Keep the legacy suggestion list below it, with its existing heading, so nothing that works today disappears.

- [ ] **Step 7: Add the reachability rows**

In `src/components/shell/reachability.test.tsx`, add rows for `control:finding-locate` and `control:finding-dismiss`. These are buttons inside a mapped list, so write the rows by hand — the guards do not see controls rendered from a map.

- [ ] **Step 8: Run the full gate**

```bash
npx tsc --noEmit; echo "tsc $?"
npx vitest run; echo "vitest $?"
npm run build; echo "build $?"
git checkout -- dist-electron
```
Expected: all three print 0.

- [ ] **Step 9: Commit**

```bash
git add -A src/stores src/components src/hooks
git commit -m "feat(review): show checklist findings in the Review panel"
```

---
### Task 9: detector check ids and the citation regex

Two small, independent changes in `src/services/detectors.ts`. They are one task because they touch one file and share its tests.

**Files:**
- Modify: `src/services/detectors.ts`
- Test: `src/services/detectors.test.ts`

**Interfaces:**
- Produces: `DetectorHit` gains `checkId: string`. `detectorSuggestions` and `freshDetectorSuggestions` keep their signatures.

- [ ] **Step 1: Write the failing tests**

Append to `src/services/detectors.test.ts`:

```ts
describe('uncited-claim citations', () => {
  const cases: [string, boolean][] = [
    ['Measles is highly contagious [1].', false],
    ['Measles is highly contagious [1,4].', false],
    ['Measles is highly contagious [2-5].', false],
    ['Measles is highly contagious [1, 3-6].', false],
    ['Measles is highly contagious [1,3,7-9].', false],
    ['Measles is highly contagious.', true],
    ['Measles is highly contagious [see below].', true],
  ];
  it.each(cases)('%s → flagged: %s', (sentence, flagged) => {
    const hits = detectorSuggestions(`It is well established that ${sentence}`);
    expect(hits.some(h => h.category === 'citation')).toBe(flagged);
  });
});

describe('detector check ids', () => {
  it('gives every hit a check id that exists in the checklist', () => {
    const text = 'We enrolled 40 mice. We enrolled 60 mice. It is well established that measles is contagious. We used PBS (phosphate-buffered saline) and PBS again.';
    for (const s of detectorSuggestions(text)) {
      expect(typeof (s as { checkId?: string }).checkId).toBe('string');
      expect(checkById((s as { checkId: string }).checkId)).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run them and confirm the citation cases fail**

Run: `npx vitest run src/services/detectors.test.ts`
Expected: FAIL on `[1,4]`, `[2-5]`, `[1, 3-6]`, `[1,3,7-9]` — the current `HAS_CITATION = /\[\d+\]/` matches only a single bare number, so a grouped or ranged citation reads as uncited.

- [ ] **Step 3: Widen the regex and add the ids**

```ts
/** A citation marker as the editor renders it: [1], [1,4], [2-5], [1, 3-6]. A citation NODE flattens to this too. */
const HAS_CITATION = /\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]/;
```

Then give each detector its check id, as the spec's §3.6 table says: N-mismatch → `*-con-numbers`, abbreviation-before-definition → `*-con-terms`, uncited claim → `*-con-uncited`, and the statistics detectors → `m-rig-tests` / `m-rig-variability` / `m-rig-n`. The `*` is `m-` for the manuscript detectors and `g-` for the ones that also run on grants; pass the document type into `detectorSuggestions` if it is not already there, defaulting to the manuscript ids so existing callers keep their behaviour.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/services/detectors.test.ts`
Expected: PASS. Watch for existing tests that asserted the old behaviour on a grouped citation; if one did, it encoded the bug — update it and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/services/detectors.ts src/services/detectors.test.ts
git commit -m "fix(detectors): read grouped citations, and name each detector's check"
```

---

### Task 10: the eval adapter, and the gate run

The last task measures what was built against the recorded baseline. It is the one that can fail the milestone.

**Files:**
- Create: `scripts/eval/review/v2.ts`
- Modify: `scripts/eval/review/run.ts`
- Modify: `docs/superpowers/plans/2026-07-04-eval-results.md`
- Test: `scripts/eval/review/v2.test.ts`

**Interfaces:**
- Consumes: `runReview`; `fixtureDoc` from `./fixtures/build`; `SystemOutput` from `./baseline`.
- Produces:
  ```ts
  export async function runV2(fx: ReviewFixture, settings: AISettings): Promise<SystemOutput & { calls: number; drops: number; failed: string[] }>;
  ```

- [ ] **Step 1: Write the adapter test (no network)**

`scripts/eval/review/v2.test.ts`: assert the mapping, not the model. Drive `runV2` with a fake `callLLM` that returns one failing verdict, and check that the resulting `NormalizedFinding` carries `sectionTitle` (not `sectionKey`) and the quote, because the scorer matches on section **titles**.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANT_FIXTURE } from './fixtures/grant';
import type { AISettings } from '../../../src/types';

const callLLM = vi.fn();
vi.mock('../../../src/services/ai', () => ({ callLLM: (...a: unknown[]) => callLLM(...a) }));
const { runV2 } = await import('./v2');

const LOCAL = { provider: 'local', localBaseUrl: 'http://127.0.0.1:1/v1/chat/completions', localModel: 'test' } as AISettings;

beforeEach(() => { callLLM.mockReset(); });

describe('runV2', () => {
  it('maps a finding sectionKey to the section TITLE the scorer expects', async () => {
    callLLM.mockImplementation(async (user: string) =>
      user.includes('[g-rig-power]')
        ? JSON.stringify({ evidence: [], verdict: 'fail', problems: [{ sectionKey: 'approach#0', quote: '', issue: 'No power analysis.', recommendation: 'Add one.' }] })
        : JSON.stringify({ evidence: [], verdict: 'pass', problems: [] }));
    const out = await runV2(GRANT_FIXTURE, LOCAL);
    const f = out.findings.find(x => x.checkId === 'g-rig-power')!;
    expect(f.sectionTitle).toBe('Approach');
    expect(out.calls).toBeGreaterThan(0);
  });

  it('reports the drop counters so a provider ignoring the schema is visible', async () => {
    callLLM.mockResolvedValue(JSON.stringify({ evidence: [], verdict: 'fail', problems: [{ sectionKey: 'not-a-section', quote: 'x', issue: 'y', recommendation: 'z' }] }));
    const out = await runV2(GRANT_FIXTURE, LOCAL);
    expect(out.findings.filter(f => f.source !== 'detector')).toEqual([]);
    expect(out.drops).toBeGreaterThan(0);
  });
});
```

The `approach#0` key must match what `sectionMap` returns for the grant fixture; print it once if the assertion fails rather than adjusting `slugify`.

- [ ] **Step 2: Write `v2.ts`**

```ts
/**
 * Eval adapter for the Review v2 engine. The scorer matches findings by section TITLE, while the engine speaks in
 * section KEYS, so this is where the two meet: build the section map once from the fixture document and translate.
 */
import { sectionMap } from '../../../src/services/review/sections';
import { runReview } from '../../../src/services/review/engine';
import { fixtureDoc } from './fixtures/build';
import type { ReviewFixture } from './fixtures/types';
import type { SystemOutput } from './baseline';
import type { AISettings } from '../../../src/types';
import type { NormalizedFinding } from './score';

export async function runV2(fx: ReviewFixture, settings: AISettings): Promise<SystemOutput & { calls: number; drops: number; failed: string[] }> {
  const doc = fixtureDoc(fx);
  const titleByKey = new Map(sectionMap(doc, fx.docType).map(s => [s.key, s.title]));
  const { run, findings } = await runReview({
    doc, docType: fx.docType, documentId: fx.id, settings,
    mechanism: fx.mechanism, projectYears: fx.projectYears,
    signal: new AbortController().signal,
  });
  const normalized: NormalizedFinding[] = findings.map(f => ({
    checkId: f.checkId,
    sectionTitle: titleByKey.get(f.anchor.sectionKey) || undefined,
    quote: f.anchor.quote ?? undefined,
    text: `${f.issue} ${f.recommendation}`.trim(),
    source: f.agent,
  }));
  return {
    findings: normalized,
    prose: run.summary ?? '',
    errors: run.failedChecks,
    calls: run.calls,
    drops: run.droppedCheckId + run.droppedSectionKey + run.droppedEmpty,
    failed: run.failedChecks,
  };
}
```

- [ ] **Step 3: Add `--system` to `run.ts`**

`parseArgs` gains `system: 'baseline' | 'v2'` (default `v2`), validated the same way `tier` is. The report prints, per fixture: recall on plants, false alarms on traps, total findings, findings matching nothing, calls, wall time, and the drop counters. Keep the markdown table row it already prints, and add the drop counters to it.

- [ ] **Step 4: Run the local gate**

```bash
EVAL_PROVIDER=openai \
EVAL_LOCAL_URL=http://127.0.0.1:8090/v1/chat/completions \
EVAL_LOCAL_MODEL=qwen \
npm run eval:review -- --tier local --system v2
```

The local server must be the standalone llama.cpp one on **:8090**. Do not point the eval at :8080 — that is the ai-backend proxy configured for a 35B model that does not fit in this GPU, and do not change its configuration. Start the server with:

```bash
~/.local/share/ai/llama.cpp/build/bin/llama-server \
  -m ~/.local/share/ai/models/Qwen3.8-27B-UD-IQ2_M.gguf --alias qwen \
  --host 127.0.0.1 --port 8090 -ngl 99 -c 24576 -np 3 -fa on -ctk q8_0 -ctv q8_0 \
  --jinja --reasoning-budget 0
```

That is 8,192 tokens per slot and about 11 GB of VRAM. **Check `nvidia-smi` before starting it and never exceed the free memory** — this is WSL2 and the desktop already holds about 2.4 GB. If less than 12 GB is free, lower `-c` (and expect the long-document case to overflow, which is what the excerpt budget is for).

Expected, against the R1 baseline of grant 8/15 with 3 trap false alarms and manuscript 10/12 with 2:

| | Gate | Probe measured, 2026-10-14 |
|---|---|---|
| synthetic grant | ≥ 10/15 recall, ≤ 2 trap FA | 14/15, 0 FA |
| synthetic manuscript | beat the baseline | 10/12, 0 FA |

If the eval scores materially below the probe, the difference is in the wiring, not the model: compare the eval's rendered prompt against the probe's for one check (`g-rig-power`) before changing anything else.

- [ ] **Step 5: Record the numbers**

Append a row per fixture to `docs/superpowers/plans/2026-07-04-eval-results.md` under a new `## R2` heading, with the date, the tier, the model, the recall, the false alarms, the unmatched count and the call count. Do not touch the R1 rows: they are the comparison.

- [ ] **Step 6: Run the cloud tier if a key is available, and say so if not**

```bash
EVAL_PROVIDER=anthropic npm run eval:review -- --tier cloud --system v2
```

There was no cloud key in this environment when the plan was written. If there still is none, record "not run: no API key in the environment" in the results file rather than leaving the row blank, and leave the cloud gate unchecked. **Do not** substitute a relay or a stand-in model and record the number as a cloud measurement.

- [ ] **Step 7: Commit**

```bash
git add scripts/eval/review docs/superpowers/plans/2026-07-04-eval-results.md
git commit -m "feat(eval): score the v2 engine, and record R2 numbers"
```

---
## Deliberate deferrals, with reasons

These are in the spec's §3 but not in this plan. Each is a decision, not an oversight; a reviewer who wants one of them back should argue against the reason given.

- **Per-aim scoping** (§3.4 step 3, "review each aim separately", default off). Measured in the spike at one extra planted weakness in nine on the real R01, for triple the findings and triple the calls. The spec itself says to revisit it "when the UI groups findings by aim", and that UI is R3. Shipping the setting in R2 would add a switch whose output the panel cannot yet organise. **Deferred to R3**, with the measurement as the reason.
- **`recallPass` for the review pass** (§3.4 step 6). The setting exists for the chunked find-then-fix pipeline, where a second "what did you miss?" pass over a chunk genuinely found more. A per-check call at temperature 0 asked the same question twice returns the same verdict, so the pass would cost 12 extra calls for nothing. R2 does not call it; the setting stays wired to the old pipeline until R4 deletes that pipeline. **If a reviewer disagrees:** the cheap experiment is to run the eval with the critical checks asked twice and compare recall, which is one flag in `scripts/eval/review/run.ts`.
- **The summary statement** (§5.1). R3, as §8 says. `ReviewRun.summary` is already on the row type so R3 adds no migration.
- **The Symbol-font DOCX import bug** (carried items). `deSymbol` exists in `src/utils/symbolFont.ts` and `crossChecks.ts` uses it, so the detectors read µ correctly today. The reader-side fix in `src/docx/read/` is still outstanding and is not R2's: it changes import, not review.

## Self-review

**Spec coverage.** Walked §2 and §3.1–3.6 against the tasks:

| Spec | Task |
|---|---|
| §2 `Finding` shape, `resolveAnchor`, fingerprint, dedupe, dismissal, re-runs | 1, 2, 7 |
| §2 persistence, Dexie v7, legacy advisory rows left alone | 7, 8 |
| §3.1 section map | already shipped in R1 and the pre-R2 tranche |
| §3.2 `renderCheckPrompt`, evidence-first schema, enums, `additionalProperties: false` | 3 |
| §3.3 cloud tier, role calls, verify, mapping and drop counts | 6 |
| §3.4 local tier, delivery by size, one call per check, detectors first, batched verify | 4, 5, 6 |
| §3.4 per-aim scoping, `recallPass` | deferred above, with reasons |
| §3.5 cancellation, progress, per-role failures, partial results | 5, 6, 8 |
| §3.6 detector mapping, citation regex | 9 (the four cross-document detectors shipped in the pre-R2 tranche) |
| §6 gates, eval adapter, unmatched count, section-title mapping | 10 |
| §7 testing list | the test steps of 1–9 |

Two §7 items have no task and should not: "fact-sheet merge and cap" (the fact sheet was dropped after the spike measured it losing recall) and "edit guard wiring" (R4, with Copy-edit).

**Type consistency.** `Finding`/`FindingAnchor` are declared once (Task 2 imports the anchor type from Task 1) and used unchanged by Tasks 5–10. `ReviewRun` is declared in Task 5 and imported by 7, 8 and 10. The repository stores both as an opaque `payload`, so R3 adding a field to either needs no migration. `mapProblems` reads both `problems` (per-check) and `findings` (role-batched), which is why one function serves both tiers.

**Review Focus coverage.** Each of the five lines has its test: (1) Task 2's dropped-key and dropped-checkId tests; (2) Task 1's occurrence test; (3) Task 1's `lost` and `moved` tests plus Task 8's two list tests; (4) Task 5's Stop test and its explicit `EXIT 0` step; (5) Task 1's headingless test, Task 3's single-key test, and the measurement's Michelson row, which is a headingless real document.

## Execution handoff

The method is already set for this program: **subagent-driven**, as it was for R1. Tasks 1–4 are mechanical given the code in this plan and suit a cheap model; Tasks 5, 6 and 8 need integration judgment and should go to a standard model; Task 10 is a measurement and needs whoever can read an eval report sceptically.

The gate for the milestone is the one in Global Constraints, plus Task 10's recorded numbers. The local tier must beat the R1 baseline (grant 8/15 with 3 trap false alarms, manuscript 10/12 with 2); the probe says it reaches 14/15 and 10/12 with none, so a materially lower eval number means the wiring differs from the probe and is worth finding before the plan is called done.
