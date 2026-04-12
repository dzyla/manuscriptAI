# PDF Abstract Extraction & Database Matching — Design Spec
**Date:** 2026-04-11  
**Status:** Approved

---

## Problem Statement

Three interconnected failures prevent reliable abstract extraction and PDF→database matching:

1. **pdfjs worker resolution**: `new URL('pdf.worker.min.mjs', import.meta.url)` fails to resolve reliably under Vite's dev server and build, causing silent empty-text extraction.
2. **Delayed persistence**: `useSourceStore.persist()` only runs on a 30s autosave interval. Exporting the workspace before that interval fires omits PDF text entirely from the JSON.
3. **Export reads stale Dexie**: `doDownload` calls `db.sources.toArray()` which can lag behind the in-memory Zustand state by the persistence interval.

As a result, `source.text` is empty after workspace reload, making the LLM-based abstract extraction always fail. Separately, the current `extractPdfAbstract` feeds raw noisy OCR text directly to the LLM with no pre-filtering, which produces poor results even when text is present. The database match search uses the digest (a structured summary) as its query, and ranks candidates with no scoring intelligence.

---

## Scope

This spec covers three independent but sequentially dependent changes:

1. PDF text persistence fixes (prerequisite for everything else)
2. Abstract Extraction Agent (AEA) replacing `extractPdfAbstract`
3. PDF→database Scoring Agent replacing the raw `searchSimilarManuscripts` result display

---

## Section 1 — PDF Text Persistence Fixes

### 1.1 Fix pdfjs worker URL (`Sidebar.tsx`)

Replace the lazy singleton pattern with a static top-level import:

```ts
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

async function getPdfjsLib() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjsLib;
}
```

Remove the `let _pdfjsLib` declaration above it.

Add an empty-text guard in `processFiles` after PDF extraction:

```ts
if (!text || text.trim().length === 0) {
  throw new Error('No text found in this PDF — is it a scanned image?');
}
```

The `catch` block in `processFiles` already surfaces errors to the user via the existing error handling path.

### 1.2 Immediate persistence (`useSourceStore.ts`)

Add fire-and-forget `get().persist()` calls to all four mutation actions:

- `addSources` — after `set()`
- `updateSource` — after `set()`
- `removeSource` — after `set()`
- `clearSources` — after `set()`

The 30s autosave loop in `App.tsx` remains unchanged as a safety net. No `await` is needed because fix 1.3 reads from memory state.

### 1.3 Export from memory state (`App.tsx`)

In `doDownload`, replace:
```ts
const exportedSources = await db.sources.toArray().catch(() => []);
```
with:
```ts
const exportedSources = useSourceStore.getState().sources;
```

This eliminates the race condition entirely — memory state is always current.

---

## Section 2 — Abstract Extraction Agent (AEA)

### Overview

Replace `extractPdfAbstract` in `ai.ts` with a new two-stage function `extractPdfAbstractAea`. Called eagerly in `processFiles` in `Sidebar.tsx` after the digest step completes, while `source.text` is guaranteed to be in memory.

### Stage 1 — Heuristic isolation

Scan the first 4000 characters of `source.text`:

- Detect abstract heading with a regex that tolerates OCR artifacts:
  ```
  /\b(A[\s\-]?B[\s\-]?S[\s\-]?T[\s\-]?R[\s\-]?A[\s\-]?C[\s\-]?T|abstract)\b/i
  ```
- Extract text from the heading until the next section boundary (`Introduction`, `Keywords`, `Background`, `Methods`, `1\.`, `2\.`, a blank line followed by an all-caps word, etc.)
- Also capture the title region: first 300 chars of source text (before any detected heading)

**If the heuristic finds a candidate abstract**: send `{ titleRegion, abstractCandidate }` to Stage 2.  
**If not**: send the full first 3000 chars as fallback.

### Stage 2 — LLM clean and normalize

Single LLM call with a focused system prompt:

```
You are given a raw OCR extract from a scientific paper.
Your ONLY task: return the abstract as clean continuous prose.
Rules:
- If given an abstract candidate, clean it: fix OCR artifacts, join broken words, remove line noise.
- If given full paper text with no clear abstract, write one in 3–5 sentences: research question, approach, key findings, significance.
- Do NOT summarize beyond what the text supports. Do NOT invent findings.
- Return ONLY the abstract text. No headings, no labels, no commentary.
- If the text is completely unintelligible, return exactly: Abstract not available.
```

Token budget: 400 output tokens max (abstracts are short).  
Input: truncated to 2000 chars (heuristic path) or 3000 chars (fallback path).

### Pipeline integration

In `processFiles`, the new upload sequence for PDFs/text files:

```
parse → addSources (immediate persist) → digest → AEA → DB search (uses abstract) → scoring agent
```

Status indicator: reuse the existing `parsingFileName` state for "Extracting abstract for {name}…" step.

Store result via `updateSource(src.id, { abstractText })`.

### Export from memory state (`App.tsx`)

`extractPdfAbstractAea` is exported from `ai.ts`. The old `extractPdfAbstract` is removed from both `ai.ts` and the import in `Sidebar.tsx`.

The lazy re-extraction on Abstract tab click (current behavior) remains as a fallback for sources that were uploaded before this change, but now calls `extractPdfAbstractAea`.

---

## Section 3 — PDF→Database Scoring Agent

### Overview

New function `scorePdfMatches(pdfName, abstractOrDigest, candidates, settings)` in `ai.ts`. Called in `processFiles` after `searchSimilarManuscripts` returns results, replacing the current raw result display.

### Pre-scoring (heuristics, no LLM)

For each of the 10 returned candidates, compute a heuristic score (0–1):

| Signal | Weight | Method |
|--------|--------|--------|
| Title word overlap | 0.6 | Jaccard similarity between filename tokens and result title tokens (stopwords removed) |
| Year match | 0.3 | Extract 4-digit year from filename; exact match with `result.year` |
| Length bonus | 0.1 | Prefer results with non-empty abstract/journal |

Sort descending by heuristic score. Keep top 5 for LLM scoring.

### LLM scoring

Single call. Input:

```
PDF filename: {pdfName}
Abstract/summary: {abstractOrDigest (max 500 chars)}

Candidates:
[1] Title | Authors | Journal Year
    Abstract excerpt (first 150 chars)
...
[5] ...
```

System prompt:
```
You are a research paper matching assistant.
Score each candidate 0–100 for how likely it is the same paper as the PDF described above.
Consider: topic match, methodology, findings, year, and any author/journal signals.
Return ONLY valid JSON: [{"index":1,"score":85,"reason":"same intervention and population"},...]
Scores must sum to ≤400. Return all 5 candidates.
```

Output: parsed JSON array, sorted by score descending. On parse failure, fall back to heuristic order with no scores shown.

### UI changes

The "Is this your paper?" card (`Sidebar.tsx`) gains:

- A confidence badge on the first (best) result: `Match confidence: 87/100`
- The LLM reason string below the journal line: `"same intervention and population"`
- Prev/next navigation cycles through the 5 scored candidates in ranked order
- The badge is omitted (UI unchanged) if scoring fails or is not yet complete

No new state keys required — `pendingPdfMatches` already stores `{ results, matchIndex }`. Add optional `scores: { score: number; reason: string }[]` to that shape.

---

## Data Flow Summary

```
File drop
  └─ extractTextFromPDF (pdfjs, fixed worker)
       └─ guard: empty text → throw error shown to user
  └─ addSources → immediate persist to Dexie
  └─ digestApiSource → updateSource({ digest }) → immediate persist
  └─ extractPdfAbstractAea
       ├─ Stage 1: heuristic isolation
       └─ Stage 2: LLM clean
       └─ updateSource({ abstractText }) → immediate persist
  └─ searchSimilarManuscripts(abstract ?? digest, 10)
  └─ scorePdfMatches(pdfName, abstract ?? digest, results[0..9], settings)
       ├─ heuristic pre-score → top 5
       └─ LLM score → sorted scored candidates
       └─ setPendingPdfMatches({ results: top5, scores, matchIndex: 0 })
```

---

## Error Handling

| Failure point | Behaviour |
|---------------|-----------|
| pdfjs extracts empty text | Error thrown, surfaced via existing `catch` block in `processFiles` — source not added |
| AEA Stage 1 finds nothing | Falls back to full-text LLM path |
| AEA LLM call fails | `abstractText` set to `undefined`; tab shows "Click to retry" |
| `scorePdfMatches` LLM fails | Falls back to heuristic order, no score badge shown |
| `searchSimilarManuscripts` fails | Silent — existing behaviour unchanged |

---

## Files Changed

| File | Change |
|------|--------|
| `src/components/Sidebar.tsx` | Worker import fix, empty-text guard, pipeline: AEA + scoring calls, UI: score badge |
| `src/stores/useSourceStore.ts` | Immediate persist on all mutations |
| `src/services/ai.ts` | Add `extractPdfAbstractAea`, add `scorePdfMatches`, remove `extractPdfAbstract` |
| `src/App.tsx` | `doDownload` reads from memory state |
| `src/types.ts` | `pendingPdfMatch` type gets optional `scores` field |

---

## Out of Scope

- Re-processing existing sources in loaded workspaces (user must re-upload PDFs to trigger AEA)
- Batch abstract extraction for already-uploaded sources
- Changing the database search API or its query format
