# Advisory suggestions + stronger expert detection

**Date:** 2026-07-05 · **Branch:** feat/review-crew-overhaul

## Problem

Every suggestion is `{originalText, suggestedText, explanation}` and Accept does
`content.replace(originalText, suggestedText)`. That is correct for text-quality
agents (`editor`, `researcher`, `manager`) which only reword existing text, but
harmful for data-dependent agents:

- `statistician` "adds the missing statistic" → invents a p-value/CI/test.
- `consistency` "gives the corrected value" → picks one conflicting number arbitrarily.
- `reporting` / `reviewer-2` "propose a sentence that supplies the item" → fabricates methodology.
- The find-fix `writeFixes` pass forces a rewrite for *every* flagged problem.

Small local models hallucinate the fabricated data. And detection misses issues
an expert should catch.

## Design

### 1. Advisory suggestion type
- `Suggestion` gains `kind?: 'edit' | 'advisory'` (default `'edit'`) and
  `recommendation?: string` (what the author must do; distinct from `explanation`).
- Advisory suggestions carry `suggestedText: ''` and never auto-replace text.

### 2. Agent classification
- `ADVISORY_AGENTS = { statistician, consistency, reporting, reviewer-2, citation-checker }`
  — always advisory (they would fabricate data).
- `editor`, `researcher`, `manager` stay edits (reword existing text, no fabrication).
- `AISettings.adviceOnly?: boolean` — global override: all agents advisory.
- `isAdvisoryAgent(agent, settings)` drives prompt choice, pipeline branch, anchoring.

### 3. Anti-hallucination prompts + pipeline
- `ADVISORIES_JSON_SCHEMA`: `{advisories:[{quote, issue, recommendation, severity, category}]}`.
- Advisory prompts (default + grant + compact) quote the span, name the issue, state
  the action, and forbid inventing values/statistics/citations/replacement text.
- Find-fix: advisory agents run a find-only pass (`findAdvisoriesChunk`) and skip
  `writeFixes` entirely — nothing to hallucinate.
- `anchorSuggestions` gets an advisory branch: anchor by quote only, skip the
  lint + no-op checks, leave `suggestedText: ''`.

### 4. Deterministic detectors (recall floor)
`src/services/detectors.ts` — pure functions over plain text → advisory suggestions
with exact quotes, run once in analyze-all: p-value with no named test; "significant"
with no stat; % without count; `mean ± x` without SD/SEM; N mismatch across sections;
abbreviation used before definition; quantitative claim with no nearby `[N]`.
Span-overlap dedupe (`dedupeAdvisories`): a detector flag beats an LLM advisory on
the same span. Unit-tested with fixtures.

### 5. Recall pass
`AISettings.recallPass` (default on): one extra find-only call given the chunk +
already-found quotes — "what high-impact issues were missed?" Merged + deduped.

### 6. Verifier & Judge
Edits: unchanged Judge + verifier (edit-only). Advisories bypass both (already
high-precision) and are deduped separately, then concatenated with kept edits.

### 7. UI & apply
- Advisory card: dimmed quoted span + explanation + recommendation, buttons
  **Insert note** / **Dismiss**, click-to-locate. No DiffView.
- Insert note = `applySuggestion(originalText, originalText + ' 《⚠ note》')`,
  reusing the editor path; recorded in history (revertable).
- `astExport` text handler strips `《⚠…》` so notes never reach LaTeX/DOCX.
- "Accept All" applies edits only, skips advisory.

### 8. Validation
`npm run eval:local` (ornith @ localhost:8080) to A/B prompts + a no-fabrication
scorer (advisory output contains no numbers absent from source). vitest for
detectors, advisory anchoring, dedupe. `npx tsc --noEmit` gate.
