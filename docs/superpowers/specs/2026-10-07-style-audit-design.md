# Style Audit ("AI-style detection") — Design

**Date:** 2026-10-07
**Sub-project:** H (parallel to A2; own branch/worktree)
**Status:** Design approved in conversation; spec pending user review

## Problem

NIH (NOT-OD-25-132, effective for due dates on/after 2025-09-25) does not consider applications
"substantially developed by AI" to be the applicant's original ideas, and post-award detection can
be referred to ORI. The user's main concern is that drafts produced or polished with AI read as
machine-written. Off-the-shelf "AI probability" detectors have non-trivial false-positive rates
(notably on non-native English writers) and give no actionable output.

## Goal

Tell the author **which sentences read as machine-written, why, and how far the draft is from their
own voice**, and help rewrite those sentences in their voice. Measure style; never claim to prove
authorship.

Success criteria:
- A per-document and per-section report comparing the draft to the author's voice profile on
  measured metrics (table, not impression).
- A ranked "worst sentences" list, highlighted in the editor, each with the specific tells found.
- "Rewrite in my voice" produces a rewrite that re-audits better, preserves numbers and citations,
  and applies exactly at the sentence's position.
- Analysis is local, deterministic and instant (no LLM call to score).

## Calibration evidence

From the user's `human-prose-audit` skill (author's unassisted vs LLM-assisted draft of the same
science): mean sentence 17.6 vs 26.8 words; >35 words 1% vs 27%; "rather than" 2.9 vs 25.2 per 100
sentences; semicolons 0 vs 21; ", which is" 0 vs 7; "is what" 0 vs 4; initial "Because" 0 vs 4.

Measured on the user's own 2020–22 grant writing (16.7k words, 787 sentences): mean 19.7 words,
7.8% >35, semicolons 0.6/100, tricolon 4.4/100, ", which is" 0.5/100, "rather than" 0.0, em dash
0.5/100, length CV 0.52. The 2025 R01 draft was first recorded here as 22.6 / 13.5% / semicolons
14.4/100 (24×) / tricolon 8.3/100. **That line was contaminated** (corrected in the final review): those figures were
measured with the draft's reference list counted as prose, because the audit did not recognise a bibliography headed
"LITERATURE CITED:" or "3. Bibliography". Measured on the real document with the bibliography excluded, the draft's
prose is mean 24.6 words, 17.4% > 35, semicolons 3.0/100 (about 5× the author's 2020–22 rate, not 24×), length CV 0.52,
tricolon 11.1/100. The audit still surfaces the genuine drift (longer sentences, more semicolons), at a realistic size.

## Non-goals

"AI probability" scores; commercial detector APIs (tier 3, declined for now); blocking or
auto-rewriting text without the author's action; detecting other people's AI use.

## Design

### 1. Metrics engine — `src/services/proseAudit/metrics.ts` (pure)

- Sentence splitting reuses `splitSentences` from `src/services/detectors.ts` (decimal-safe: does
  not split "p < 0.01"), filtered to sentences with > 3 words (kernel rule). Headings, citation-only
  lines and reference-list paragraphs are excluded (a References/Bibliography heading ends analysis
  of that section).
- Tell patterns ported verbatim from the skill kernel (`rather than`, `not X but/instead`,
  `instead of`, `is what` cleft, `, which is` appositive, initial `Because`, `This/That` anaphora,
  semicolon, tricolon, throat-clearing), plus additions with their own names: em dash,
  `not only … but also`, paragraph-initial `Moreover|Furthermore|Additionally`, closing summary
  openers (`In summary|Overall,|Taken together|In conclusion`), and a stock-vocabulary list
  (`delve, underscore(s|d), pivotal, intricate, tapestry, landscape, multifaceted, nuanced, foster,
  showcase, leverage, robust, seamless, comprehensive, crucial, paramount, realm, testament`).
  Each pattern carries a weight; kernel patterns keep the kernel's equal weight.
- `auditText(text) → AuditMetrics`: sentence count, mean words, % > 35 words, length CV, per-pattern
  counts and per-100-sentence rates, and per-sentence records `{ start, end, words, tells[] }`
  with absolute offsets.
- `worstSentences(metrics, k)`: kernel severity `words + 8 × tells`.
- Parity: a fixture test compares the TS port with the Python kernel's numbers on the same texts
  (expected values generated once by running `kernel.py`, committed as JSON; the texts are
  synthetic or public, never the user's grants).

### 2. Voice profile — `src/services/proseAudit/profile.ts`

- `VoiceProfile = { name, createdAt, sampleWords, metrics: AuditSummary, exampleSentences: string[] }`
  where `AuditSummary` is the aggregate part of `AuditMetrics` and `exampleSentences` are 8 short,
  representative sentences used as few-shot style examples for rewriting.
- Built in-app from user-provided samples (paste, or pick existing Sources/uploaded files — PDF/DOCX
  text extraction already exists). Minimum 1,500 words, with a warning below 2,000.
- Stored with AI settings (`AISettings.voiceProfile`, persisted by `useAIStore`) — no Dexie schema
  change, so H does not collide with A2's database work.
- Default when no profile exists: the skill's human column (17.6 words, 1% > 35, near-zero tells),
  labeled "generic human baseline".
- Reference "machine" profile constant: the skill's LLM column, used to scale distances.

### 3. Scoring — `src/services/proseAudit/score.ts`

- Per metric m: `d_m = clamp((draft_m − voice_m) / (machine_m − voice_m), 0, 1.5)`; metrics where the
  machine reference is not above the voice value use a fixed per-metric scale instead.
- **Distance from your voice** = weighted mean of `d_m` (weights: mean length 2, % > 35 2,
  contrastive patterns 2, semicolon 1.5, others 1; the nine untabulated tells 0.5), reported as 0–100 with bands
  *close* (< 25), *drifting* (25–50), *far* (> 50). Labeled as style distance, with a one-line note
  that it does not prove authorship. With no voice profile the reference is the generic baseline and the panel
  says "typical-writing baseline", never "your voice".
- **Tricolon is measured and shown, not scored.** The machine value (12 per 100) was always an estimate, and the
  author's own unassisted R01 prose measures 11.1 per 100, almost the whole scale, so the metric cannot discriminate.
- **Density semantics (what is and is not guaranteed).** Every tell metric is a density (per 100 sentences, or a
  mean), so the score is not a count. Guaranteed: raising any one scored metric's draft value, others fixed, never
  lowers the distance, and drift below the voice scores 0. Not guaranteed: adding text never lowers it. Appending
  clean sentences dilutes every rate and can lower the score (20 long tell-free sentences moved one draft from 82
  to 80), and in the clamp regime tripling clean prose at the same absolute tell count can drop it sharply. This is
  intended: the score measures the style of the whole draft, and per-sentence severity (words + 8 x tells) is
  the place to look for individual tells.
- A section with fewer than 5 sentences is shown as "not measured" with its sentence count; a section with none is
  not shown.
- Per section (split on H1–H3 headings) and per document.

### 4. UI

- **Style tab** in the sidebar (`src/components/style/StylePanel.tsx`): score badge, comparison table
  (voice vs draft, flags where draft exceeds voice by > 50%), section breakdown, worst-sentence list
  (word count, tell chips, click → scroll + flash). Voice-profile manager (create from samples,
  rename, delete, show its metrics).
- **Editor highlights** (`src/extensions/StyleHighlights.ts`): ProseMirror decoration plugin
  (decorations only, never marks — the document is not modified). Toggle "Show style highlights".
  Severity tint by sentence score; hover tooltip lists tells. Positions come from mapping plain-text
  offsets to document positions via the existing `flattenDoc` in `src/utils/textMatch.ts`.
- Live: recompute debounced (≈400 ms) on document change; analysis is regex-only.

### 5. Rewrite in my voice — `src/services/proseAudit/rewrite.ts`

- Prompt rules from the skill: rewrite from the idea (do not edit); target the voice's mean sentence
  length; no semicolons, contrastive definitions, clefts, appositive pile-ups, throat-clearing,
  em dashes; keep every number, unit, gene/protein name and citation marker; may split into two
  sentences. Few-shot: the profile's `exampleSentences`. Context: the preceding and following
  sentence.
- Uses the existing provider-agnostic `callLLM` (export it from `src/services/ai.ts`) with the
  existing thinking suppression; output passes `stripThinkingBlocks` and `lintSuggestedText`.
- Guards (deterministic): every numeric token and `[N]` citation in the original appears in the
  rewrite; rewrite severity < original severity. On failure, one retry with the failure reason
  appended; then show the best attempt flagged "check facts" or report failure.
- Apply: replaces exactly the sentence's document range (from the decoration's mapped positions),
  as one undoable transaction. Before sub-project B lands, this is a direct editor transaction, not
  a Suggestion card.

### 6. Tier-2 spike — Binoculars feasibility (throwaway)

Script `scripts/spikes/binoculars-local.ts` + findings note. Questions: does the user's llama.cpp
server (`http://localhost:8080`, model `ornith`) return per-token log-probabilities for supplied
text (prompt logprobs / echo), and can a second compatible model run alongside? Compute log-ppl and
cross-ppl on two short texts (one human paragraph from public text, one model-generated) if possible.
Output: `docs/superpowers/plans/2026-10-07-binoculars-spike.md` with a go/no-go recommendation. No
app code.

## Testing

- Unit: each tell pattern (positive + negative cases incl. "however", passive voice, decimals);
  sentence filtering (headings, references); kernel parity; scoring monotonicity per metric (raising one
  metric's draft value never lowers the distance; see density semantics above); profile building; rewrite guards (numbers,
  citations, severity).
- Decoration plugin: offsets map to the right document ranges across headings, citations and
  tables (jsdom editor test).
- `npm run eval:local` addition: rewrite quality on a seeded set of machine-style sentences against
  the local model — severity reduced, facts preserved, no thinking leak.
- Gates: `npx tsc --noEmit`, `npx vitest run`.

## Files

New: `src/services/proseAudit/{metrics,profile,score,rewrite,patterns}.ts` + tests,
`src/components/style/{StylePanel,VoiceProfileManager}.tsx`, `src/extensions/StyleHighlights.ts`,
`src/test/fixtures/proseAudit/*` (synthetic texts + kernel parity JSON),
`scripts/spikes/binoculars-local.ts`.
Changed (small, to limit A2 conflicts): `src/services/ai.ts` (export `callLLM`), `src/types.ts`
(`AISettings.voiceProfile`), `src/components/Sidebar.tsx` (one tab), `src/components/Editor.tsx`
(register `StyleHighlights`, expose a sentence-range replace method), `scripts/eval/*`.
